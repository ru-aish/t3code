/**
 * The only module that knows ChatGPT Desktop's CDP/renderer details. Nothing
 * outside this adapter may depend on DOM selectors, renderer state, or CDP.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const TURN_SELECTOR = '[data-chatgpt-conversation-turn="true"]';
const TURN_ID_ATTRIBUTE = "data-chatgpt-conversation-turn-id";
const RESPONSE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const SETTLED_POLLS = 3;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu;

export class ChatGPTDesktopBridgeError extends Schema.TaggedErrorClass<ChatGPTDesktopBridgeError>()(
  "ChatGPTDesktopBridgeError",
  {
    kind: Schema.Literals(["unavailable", "incompatible", "timeout", "interrupted"]),
    detail: Schema.String,
  },
) {
  override get message() {
    return `ChatGPT Desktop ${this.kind}: ${this.detail}`;
  }
}

export interface ChatGPTDesktopBridgeShape {
  readonly health: (
    endpoint: string,
  ) => Effect.Effect<
    { readonly compatible: boolean; readonly detail: string },
    ChatGPTDesktopBridgeError
  >;
  /** Opens an existing stable conversation, sends text, and yields only new assistant text. */
  readonly send: (input: {
    readonly endpoint: string;
    readonly conversationId?: string;
    readonly text: string;
    readonly signal?: AbortSignal;
  }) => AsyncIterable<{
    readonly conversationId: string;
    readonly text: string;
  }>;
}

export class ChatGPTDesktopBridge extends Context.Service<
  ChatGPTDesktopBridge,
  ChatGPTDesktopBridgeShape
>()("t3/chatgptAgent/ChatGPTDesktopBridge") {}

type CdpSocket = {
  send(message: string): void;
  close(): void;
  addEventListener(
    name: "open" | "message" | "error" | "close",
    listener: (event: MessageEvent | Event) => void,
  ): void;
  removeEventListener(
    name: "open" | "message" | "error" | "close",
    listener: (event: MessageEvent | Event) => void,
  ): void;
};

type RendererTurn = { readonly id: string; readonly text: string; readonly role: string };
type RendererProbe = {
  readonly composer?: boolean;
  readonly conversationId?: string | null;
};

const unavailable = (detail: string) =>
  new ChatGPTDesktopBridgeError({ kind: "unavailable", detail });
const interrupted = () =>
  new ChatGPTDesktopBridgeError({
    kind: "interrupted",
    detail: "The T3 turn was interrupted; ChatGPT Desktop continues to own its response.",
  });

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d+$/u.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

function validateEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw unavailable("ChatGPT Desktop CDP endpoint must be a loopback HTTP URL.");
  }
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.username || url.password)
    throw unavailable("ChatGPT Desktop CDP endpoint must use HTTP on a local loopback address.");
  return url;
}

function validateWebSocketEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ChatGPTDesktopBridgeError({
      kind: "incompatible",
      detail: "ChatGPT Desktop returned an invalid CDP WebSocket endpoint.",
    });
  }
  if (url.protocol !== "ws:" || !isLoopbackHost(url.hostname) || url.username || url.password)
    throw new ChatGPTDesktopBridgeError({
      kind: "incompatible",
      detail: "ChatGPT Desktop returned a non-loopback CDP WebSocket endpoint.",
    });
  return url.toString();
}

function endpointUrl(endpoint: URL, suffix: string): string {
  return new URL(suffix, endpoint).toString();
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(interrupted());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => fail(interrupted());
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function fail(error: ChatGPTDesktopBridgeError) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function discoverTarget(
  endpoint: string,
  signal?: AbortSignal,
): Promise<{ webSocketDebuggerUrl: string }> {
  const base = validateEndpoint(endpoint);
  let response: Response;
  try {
    response = await fetch(endpointUrl(base, "/json/list"), {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)])
        : AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch {
    if (signal?.aborted) throw interrupted();
    throw unavailable(
      `Could not reach CDP at ${base.origin}. Start ChatGPT Desktop with its loopback debugging endpoint enabled.`,
    );
  }
  if (!response.ok) throw unavailable(`CDP at ${base.origin} returned HTTP ${response.status}.`);
  let targets: Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
  try {
    targets = (await response.json()) as typeof targets;
  } catch {
    throw new ChatGPTDesktopBridgeError({
      kind: "incompatible",
      detail: "ChatGPT Desktop returned an invalid CDP target list.",
    });
  }
  if (!Array.isArray(targets))
    throw new ChatGPTDesktopBridgeError({
      kind: "incompatible",
      detail: "ChatGPT Desktop returned an invalid CDP target list.",
    });
  const target = targets.find(
    (candidate) =>
      candidate.type === "page" &&
      /chatgpt\.com|chat\.openai\.com/iu.test(candidate.url ?? "") &&
      candidate.webSocketDebuggerUrl,
  );
  if (!target?.webSocketDebuggerUrl)
    throw new ChatGPTDesktopBridgeError({
      kind: "incompatible",
      detail: "CDP is reachable, but no logged-in ChatGPT renderer target was found.",
    });
  return { webSocketDebuggerUrl: validateWebSocketEndpoint(target.webSocketDebuggerUrl) };
}

async function openCdp(
  endpoint: string,
  signal?: AbortSignal,
  timeouts: { readonly connectMs?: number; readonly commandMs?: number } = {},
): Promise<{
  evaluate: (expression: string, signal?: AbortSignal) => Promise<unknown>;
  close: () => void;
}> {
  const connectMs = timeouts.connectMs ?? CONNECT_TIMEOUT_MS;
  const commandMs = timeouts.commandMs ?? COMMAND_TIMEOUT_MS;
  const target = await discoverTarget(endpoint, signal);
  if (signal?.aborted) throw interrupted();
  const socket = new WebSocket(target.webSocketDebuggerUrl) as unknown as CdpSocket;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: ChatGPTDesktopBridgeError): void;
      cleanup(): void;
    }
  >();
  const rejectPending = (error: ChatGPTDesktopBridgeError) => {
    for (const request of pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    pending.clear();
  };
  const onMessage = (event: MessageEvent | Event) => {
    if (closed || !("data" in event)) return;
    let value: {
      id?: number;
      result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
      error?: { message?: string };
    };
    try {
      value = JSON.parse(String(event.data)) as typeof value;
    } catch {
      return;
    }
    if (typeof value.id !== "number") return;
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    request.cleanup();
    if (value.error || value.result?.exceptionDetails)
      request.reject(
        new ChatGPTDesktopBridgeError({
          kind: "incompatible",
          detail:
            value.error?.message ??
            value.result?.exceptionDetails?.text ??
            "Renderer evaluation failed.",
        }),
      );
    else request.resolve(value.result?.result?.value);
  };
  const removeListeners = () => {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onError);
  };
  const onClose = () => {
    if (closed) return;
    closed = true;
    rejectPending(unavailable("The ChatGPT Desktop CDP connection closed."));
    removeListeners();
  };
  const onError = () => {
    if (closed) return;
    closed = true;
    rejectPending(unavailable("The ChatGPT Desktop CDP connection failed."));
    removeListeners();
    try {
      socket.close();
    } catch {
      // Closing an already failed WebSocket is best effort.
    }
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onError);
  const close = () => {
    if (closed) return;
    closed = true;
    removeListeners();
    rejectPending(interrupted());
    try {
      socket.close();
    } catch {
      // Closing a failed WebSocket is best effort.
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onOpenError);
        socket.removeEventListener("close", onOpenClose);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onOpen = () => finish(resolve);
      const onOpenError = () =>
        finish(() => reject(unavailable("ChatGPT Desktop rejected the CDP connection.")));
      const onOpenClose = () =>
        finish(() =>
          reject(unavailable("ChatGPT Desktop closed the CDP connection before it opened.")),
        );
      const onAbort = () => finish(() => reject(interrupted()));
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(unavailable("Timed out connecting to the ChatGPT Desktop CDP target.")),
          ),
        connectMs,
      );
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onOpenError);
      socket.addEventListener("close", onOpenClose);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  } catch (error) {
    close();
    throw error;
  }
  let nextId = 1;
  const evaluate = (expression: string, commandSignal?: AbortSignal) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) return reject(unavailable("The ChatGPT Desktop CDP connection is closed."));
      if (commandSignal?.aborted || signal?.aborted) return reject(interrupted());
      const id = nextId++;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        commandSignal?.removeEventListener("abort", onAbort);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        pending.delete(id);
        cleanup();
        callback();
      };
      const onAbort = () => finish(() => reject(interrupted()));
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new ChatGPTDesktopBridgeError({
                kind: "timeout",
                detail: "ChatGPT Desktop did not complete a CDP command in time.",
              }),
            ),
          ),
        commandMs,
      );
      pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
        cleanup,
      });
      commandSignal?.addEventListener("abort", onAbort, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
      } catch {
        finish(() => reject(unavailable("Could not send a CDP command to ChatGPT Desktop.")));
      }
    });
  return { evaluate, close };
}

async function withCdp<T>(
  endpoint: string,
  run: (evaluate: (expression: string, signal?: AbortSignal) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const cdp = await openCdp(endpoint);
  try {
    return await run(cdp.evaluate);
  } finally {
    cdp.close();
  }
}

const rendererProbe = `(() => ({ composer: Boolean(document.querySelector('textarea, [contenteditable="true"]')), conversationId: location.pathname.match(/\\/c\\/(${UUID.source})/iu)?.[1] ?? null }))()`;
const setAndSend = (text: string) => `(() => {
  const editor = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
  const send = [...document.querySelectorAll('button')].find((button) => /send/i.test(button.getAttribute('aria-label') || button.textContent || ''));
  if (!editor || !send) return { ok: false };
  if (editor instanceof HTMLTextAreaElement) { editor.focus(); editor.value = ${JSON.stringify(text)}; editor.dispatchEvent(new Event('input', { bubbles: true })); }
  else { editor.focus(); editor.textContent = ${JSON.stringify(text)}; editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} })); }
  send.click(); return { ok: true };
})()`;
const navigateConversation = (id: string) =>
  `(() => { location.assign('/c/${id}'); return true; })()`;
const readTurns = `(() => [...document.querySelectorAll(${JSON.stringify(TURN_SELECTOR)})].map((turn) => { const message = turn.matches('[data-message-author-role]') ? turn : turn.querySelector('[data-message-author-role]'); return { id: turn.getAttribute(${JSON.stringify(TURN_ID_ATTRIBUTE)}), role: message?.getAttribute('data-message-author-role') || '', text: message?.textContent || '' }; }).filter((turn) => turn.id))()`;
const isGenerating = `(() => Boolean(document.querySelector('[data-testid*="stop" i], button[aria-label*="stop" i]')))`;
const discoverConversation = `(() => location.pathname.match(/\\/c\\/(${UUID.source})/iu)?.[1] ?? null)()`;

function assistantTurns(turns: ReadonlyArray<RendererTurn>): ReadonlyArray<RendererTurn> {
  return turns.filter((turn) => turn.role === "assistant" && turn.text.trim().length > 0);
}

function contextWasReplaced(error: unknown): boolean {
  return (
    error instanceof ChatGPTDesktopBridgeError &&
    /context.*(destroyed|not found)|target.*navigat/iu.test(error.detail)
  );
}

async function evaluateWithRetry(
  evaluate: (expression: string, signal?: AbortSignal) => Promise<unknown>,
  expression: string,
  signal?: AbortSignal,
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw interrupted();
    try {
      return await evaluate(expression, signal);
    } catch (error) {
      if (!contextWasReplaced(error) || attempt >= 4) throw error;
      await abortableDelay(POLL_INTERVAL_MS, signal);
    }
  }
}

async function waitForRenderer(
  evaluate: (expression: string, signal?: AbortSignal) => Promise<unknown>,
  expectedConversationId: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const probe = (await evaluateWithRetry(evaluate, rendererProbe, signal)) as RendererProbe;
    if (
      probe?.composer &&
      (!expectedConversationId || probe.conversationId === expectedConversationId)
    )
      return;
    await abortableDelay(POLL_INTERVAL_MS, signal);
  }
  throw new ChatGPTDesktopBridgeError({
    kind: "timeout",
    detail: expectedConversationId
      ? "Timed out opening the saved ChatGPT conversation."
      : "Timed out waiting for the ChatGPT renderer.",
  });
}

/** Kept as an async generator so cancellation only owns the active response, never ChatGPT's tools. */
async function* streamSend(
  input: Parameters<ChatGPTDesktopBridgeShape["send"]>[0],
): AsyncIterable<{ conversationId: string; text: string }> {
  const cdp = await openCdp(input.endpoint, input.signal);
  try {
    const { evaluate } = cdp;
    if (input.conversationId) {
      await evaluateWithRetry(evaluate, navigateConversation(input.conversationId), input.signal);
      await waitForRenderer(evaluate, input.conversationId, input.signal);
      const activeId = String(
        (await evaluateWithRetry(evaluate, discoverConversation, input.signal)) ?? "",
      );
      if (activeId !== input.conversationId)
        throw new ChatGPTDesktopBridgeError({
          kind: "incompatible",
          detail: "ChatGPT Desktop did not open the requested saved conversation.",
        });
    } else await waitForRenderer(evaluate, undefined, input.signal);
    const before = new Set(
      assistantTurns(
        (await evaluateWithRetry(evaluate, readTurns, input.signal)) as RendererTurn[],
      ).map((turn) => turn.id),
    );
    const sent = (await evaluateWithRetry(evaluate, setAndSend(input.text), input.signal)) as {
      ok?: boolean;
    };
    if (!sent?.ok)
      throw new ChatGPTDesktopBridgeError({
        kind: "incompatible",
        detail: "ChatGPT renderer does not expose a supported send control.",
      });
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    let conversationId = input.conversationId ?? "";
    let previous = "";
    let responseStarted = false;
    let sawGenerating = false;
    let stable = 0;
    while (Date.now() < deadline) {
      if (input.signal?.aborted) throw interrupted();
      conversationId ||= String(
        (await evaluateWithRetry(evaluate, discoverConversation, input.signal)) ?? "",
      );
      const turns = assistantTurns(
        (await evaluateWithRetry(evaluate, readTurns, input.signal)) as RendererTurn[],
      );
      const newest = turns.toReversed().find((turn) => !before.has(turn.id));
      const text = newest?.text ?? "";
      const generating = Boolean(await evaluateWithRetry(evaluate, isGenerating, input.signal));
      if (text.length > 0) {
        responseStarted = true;
        if (text.length > previous.length) {
          if (!UUID.test(conversationId)) {
            await abortableDelay(POLL_INTERVAL_MS, input.signal);
            continue;
          }
          yield { conversationId, text: text.slice(previous.length) };
          previous = text;
          stable = 0;
        } else stable += 1;
      }
      sawGenerating ||= generating;
      if (responseStarted && ((sawGenerating && !generating) || stable >= SETTLED_POLLS)) return;
      await abortableDelay(POLL_INTERVAL_MS, input.signal);
    }
    throw new ChatGPTDesktopBridgeError({
      kind: "timeout",
      detail: "Timed out waiting for ChatGPT Desktop's assistant response.",
    });
  } finally {
    cdp.close();
  }
}

export const ChatGPTDesktopBridgeLive = Layer.succeed(ChatGPTDesktopBridge, {
  health: (endpoint) =>
    Effect.tryPromise({
      try: async () => {
        await withCdp(endpoint, async (evaluate) => {
          await waitForRenderer(evaluate, undefined);
        });
        return { compatible: true, detail: "Connected to ChatGPT Desktop." };
      },
      catch: (cause) =>
        cause instanceof ChatGPTDesktopBridgeError
          ? cause
          : unavailable("Unable to inspect ChatGPT Desktop."),
    }),
  send: streamSend,
});

/** Narrow test seam for CDP transport and renderer-state behavior. */
export const ChatGPTDesktopBridgeTest = {
  assistantTurns,
  discoverTarget,
  openCdp,
  streamSend,
  validateEndpoint,
  validateWebSocketEndpoint,
  waitForRenderer,
};
