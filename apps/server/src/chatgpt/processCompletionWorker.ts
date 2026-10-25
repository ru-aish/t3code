// @effect-diagnostics globalFetch:off globalTimers:off -- Terminal MCP is an authenticated local long-poll transport.
import { MessageId, ProviderThreadId, ThreadId, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { CHATGPT_DRIVER } from "./adapter.ts";
import type { TerminalEvent } from "./connection.ts";

export interface ProcessCompletionTransport {
  readonly events: (signal: AbortSignal) => AsyncIterable<TerminalEvent>;
  readonly claim: (event: TerminalEvent) => Promise<boolean>;
  readonly acknowledge: (event: TerminalEvent) => Promise<void>;
}

export interface TerminalProcessConfig {
  readonly endpoint: string;
  readonly token: string;
  readonly environmentId: string;
  readonly providerId: ProviderInstanceId;
}

export function makeProcessCompletionTransport(
  config: TerminalProcessConfig,
): ProcessCompletionTransport {
  const endpoint = new URL(config.endpoint);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("Terminal control plane must be loopback");
  }
  const headers = {
    authorization: `Bearer ${config.token}`,
  };
  const control = async (event: TerminalEvent, action: string) => {
    const response = await fetch(new URL(`/v1/${action}`, endpoint), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        threadId: event.thread_id,
        environmentId: config.environmentId,
        providerId: config.providerId,
        eventId: event.event_id,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Terminal MCP ${action} failed (${response.status})`);
    return (await response.json()) as { valid?: boolean };
  };
  return {
    async *events(signal) {
      // Replay unacknowledged durable events on startup, including completions
      // recorded while T3 was down. This is one long poll per enabled instance,
      // independent of all provider-session scopes.
      let after = 0;
      while (!signal.aborted) {
        const url = new URL("/v1/events", endpoint);
        url.searchParams.set("environmentId", config.environmentId);
        url.searchParams.set("providerId", config.providerId);
        url.searchParams.set("afterSeq", String(after));
        url.searchParams.set("waitSeconds", "25");
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
        });
        if (!response.ok) throw new Error(`Terminal MCP events failed (${response.status})`);
        const body = (await response.json()) as { events: TerminalEvent[] };
        for (const event of body.events) {
          after = event.seq;
          if (event.kind === "process.completed" && !event.acknowledged) yield event;
        }
      }
    },
    claim: async (event) => (await control(event, "claim")).valid === true,
    acknowledge: async (event) => {
      await control(event, "ack");
    },
  };
}

export function processCompletionRequest(
  event: TerminalEvent,
  transport: ProcessCompletionTransport,
): ProviderContinuationRequests.ProviderContinuationRequest | undefined {
  const processId = event.payload.processId;
  if (event.kind !== "process.completed" || event.acknowledged || !processId) return undefined;
  const threadId = ThreadId.make(event.thread_id);
  const { result } = event.payload;
  const status =
    event.payload.status ??
    (typeof result === "object" && result !== null ? result.status : undefined);
  const exitCode =
    event.payload.exitCode ??
    (typeof result === "object" && result !== null ? result.exit_code : undefined) ??
    (typeof result === "string" && /^exit_code=-?\d+$/.test(result)
      ? Number(result.slice("exit_code=".length))
      : undefined);
  const resultText =
    typeof result === "string"
      ? result
      : exitCode !== undefined && exitCode !== null
        ? `exit_code=${exitCode}`
        : (status ?? "unknown");
  const outcome =
    status === "cancelled"
      ? "cancelled"
      : exitCode === 0
        ? "completed"
        : (exitCode !== undefined && exitCode !== null) || status === "supervisor_error"
          ? "failed"
          : "unknown";
  return {
    threadId,
    providerThreadId: ProviderThreadId.make(`chatgpt:${threadId}`),
    driver: CHATGPT_DRIVER,
    messageId: MessageId.make(`process:${event.event_id}`),
    delivery: "message_text",
    detail: `Background process ${processId} finished (${resultText}). Use durable_process_status and durable_process_output with job_id ${processId} for its result and output.`,
    notification: {
      source: { kind: "background_task" },
      outcome,
      summary: `Background process ${processId} finished`,
    },
    dispatchIfCurrent: (effect) =>
      Effect.gen(function* () {
        if (!(yield* Effect.promise(() => transport.claim(event)))) return Option.none();
        // The durable T3 message.dispatch receipt, not a queue offer,
        // must precede acknowledgment of the Terminal MCP source event.
        const accepted = yield* effect;
        yield* Effect.promise(() => transport.acknowledge(event));
        return Option.some(accepted);
      }),
  };
}

export const startProcessCompletionWorker = (
  transport: ProcessCompletionTransport,
  requests: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const abort = new AbortController();
    yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()));
    // An async generator is single-use after it fails. Reopen it on each retry.
    yield* Stream.suspend(() =>
      Stream.fromAsyncIterable(transport.events(abort.signal), (cause) => new Error(String(cause))),
    ).pipe(
      Stream.runForEach((event) => {
        const request = processCompletionRequest(event, transport);
        return request === undefined ? Effect.void : requests.offer(request);
      }),
      Effect.catchCause((cause) =>
        abort.signal.aborted
          ? Effect.void
          : Effect.logWarning("chatgpt.process-completion-listener.failed", { cause }),
      ),
      Effect.andThen(Effect.sleep("5 seconds")),
      Effect.forever,
      Effect.forkScoped,
    );
  });
