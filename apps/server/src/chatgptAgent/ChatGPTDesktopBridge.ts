/**
 * The only module that knows ChatGPT Desktop's CDP/renderer details.  Nothing
 * outside this adapter may depend on DOM selectors, renderer state, or CDP.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const TURN_SELECTOR = '[data-chatgpt-conversation-turn="true"]';
const TURN_ID_ATTRIBUTE = "data-chatgpt-conversation-turn-id";
const RESPONSE_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu;

export class ChatGPTDesktopBridgeError extends Schema.TaggedErrorClass<ChatGPTDesktopBridgeError>()(
  "ChatGPTDesktopBridgeError",
  {
    kind: Schema.Literals([
      "unavailable",
      "incompatible",
      "timeout",
      "interrupted",
    ]),
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
    name: "message" | "error" | "close",
    listener: (event: MessageEvent | Event) => void,
  ): void;
  removeEventListener(
    name: "message" | "error" | "close",
    listener: (event: MessageEvent | Event) => void,
  ): void;
};

function endpointUrl(endpoint: string, suffix: string): string {
  return `${endpoint.replace(/\/$/u, "")}${suffix}`;
}

async function discoverTarget(
  endpoint: string,
): Promise<{ webSocketDebuggerUrl: string }> {
  let response: Response;
  try {
    response = await fetch(endpointUrl(endpoint, "/json/list"), {
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new ChatGPTDesktopBridgeError({
      kind: "unavailable",
      detail: `Could not reach CDP at ${endpoint}. Start ChatGPT Desktop with its loopback debugging endpoint enabled.`,
    });
  }
  if (!response.ok)
    throw new ChatGPTDesktopBridgeError({
      kind: "unavailable",
      detail: `CDP at ${endpoint} returned HTTP ${response.status}.`,
    });
  const targets = (await response.json()) as Array<{
    type?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
  }>;
  const target = targets.find(
    (candidate) =>
      candidate.type === "page" &&
      /chatgpt\.com|chat\.openai\.com/iu.test(candidate.url ?? "") &&
      candidate.webSocketDebuggerUrl,
  );
  if (!target?.webSocketDebuggerUrl)
    throw new ChatGPTDesktopBridgeError({
      kind: "incompatible",
      detail:
        "CDP is reachable, but no logged-in ChatGPT renderer target was found.",
    });
  return { webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

async function openCdp(
  endpoint: string,
): Promise<{
  evaluate: (expression: string) => Promise<unknown>;
  close: () => void;
}> {
  const target = await discoverTarget(endpoint);
  const socket = new WebSocket(
    target.webSocketDebuggerUrl,
  ) as unknown as CdpSocket;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new ChatGPTDesktopBridgeError({
            kind: "unavailable",
            detail: "Timed out connecting to the ChatGPT Desktop CDP target.",
          }),
        ),
      5_000,
    );
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(
        new ChatGPTDesktopBridgeError({
          kind: "unavailable",
          detail: "ChatGPT Desktop rejected the CDP connection.",
        }),
      );
    });
    // Browser WebSocket implementations do not expose a typed open listener in this narrow adapter.
    (
      socket as unknown as {
        addEventListener(name: "open", listener: () => void): void;
      }
    ).addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  const onMessage = (event: MessageEvent | Event) => {
    if (!("data" in event)) return;
    const value = JSON.parse(String(event.data)) as {
      id?: number;
      result?: {
        result?: { value?: unknown };
        exceptionDetails?: { text?: string };
      };
      error?: { message?: string };
    };
    if (value.id === undefined) return;
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
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
  socket.addEventListener("message", onMessage);
  const evaluate = (expression: string) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  return {
    evaluate,
    close: () => {
      socket.removeEventListener("message", onMessage);
      socket.close();
    },
  };
}

async function withCdp<T>(
  endpoint: string,
  run: (evaluate: (expression: string) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const cdp = await openCdp(endpoint);
  try {
    return await run(cdp.evaluate);
  } finally {
    cdp.close();
  }
}

const rendererProbe = `(() => ({ turns: document.querySelectorAll(${JSON.stringify(TURN_SELECTOR)}).length, composer: Boolean(document.querySelector('textarea, [contenteditable="true"]')), url: location.href }))()`;
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
const readAssistant = `(() => [...document.querySelectorAll(${JSON.stringify(TURN_SELECTOR)})].map((turn) => ({ id: turn.getAttribute(${JSON.stringify(TURN_ID_ATTRIBUTE)}), text: turn.textContent || '' })).filter((turn) => turn.id && turn.text.trim().length > 0))()`;
const discoverConversation = `(() => { const match = location.href.match(${UUID.toString()}); if (match) return match[0]; const serialized = document.documentElement.innerHTML.match(${UUID.toString()}); return serialized ? serialized[0] : null; })()`;

/** Kept as an async generator so cancellation only owns the active response, never ChatGPT's tools. */
async function* streamSend(
  input: Parameters<ChatGPTDesktopBridgeShape["send"]>[0],
): AsyncIterable<{ conversationId: string; text: string }> {
  const cdp = await openCdp(input.endpoint);
  try {
    const { evaluate } = cdp;
    if (input.conversationId)
      await evaluate(navigateConversation(input.conversationId));
    const probe = (await evaluate(rendererProbe)) as {
      turns?: number;
      composer?: boolean;
    };
    if (!probe?.composer)
      throw new ChatGPTDesktopBridgeError({
        kind: "incompatible",
        detail:
          "ChatGPT renderer does not expose a supported composer. Its UI may have changed.",
      });
    const before = new Set(
      ((await evaluate(readAssistant)) as Array<{ id: string }>).map(
        (turn) => turn.id,
      ),
    );
    const sent = (await evaluate(setAndSend(input.text))) as { ok?: boolean };
    if (!sent?.ok)
      throw new ChatGPTDesktopBridgeError({
        kind: "incompatible",
        detail: "ChatGPT renderer does not expose a supported send control.",
      });
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    let conversationId = input.conversationId ?? "";
    let announcedConversation = false;
    let previous = "";
    let stable = 0;
    while (Date.now() < deadline) {
      if (input.signal?.aborted)
        throw new ChatGPTDesktopBridgeError({
          kind: "interrupted",
          detail:
            "The T3 turn was interrupted; ChatGPT Desktop continues to own its response.",
        });
      conversationId ||= String((await evaluate(discoverConversation)) ?? "");
      if (!UUID.test(conversationId)) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }
      if (!announcedConversation) {
        announcedConversation = true;
        yield { conversationId, text: "" };
      }
      const turns = (await evaluate(readAssistant)) as Array<{
        id: string;
        text: string;
      }>;
      const newest = [...turns].reverse().find((turn) => !before.has(turn.id));
      const text = newest?.text ?? "";
      if (text.length > previous.length) {
        yield { conversationId, text: text.slice(previous.length) };
        previous = text;
        stable = 0;
      } else if (text.length > 0) stable += 1;
      if (text.length > 0 && stable >= 2) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
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
          const probe = (await evaluate(rendererProbe)) as {
            turns?: number;
            composer?: boolean;
          };
          if (!probe?.composer)
            throw new ChatGPTDesktopBridgeError({
              kind: "incompatible",
              detail: "ChatGPT renderer does not expose a supported composer.",
            });
        });
        return { compatible: true, detail: "Connected to ChatGPT Desktop." };
      },
      catch: (cause) =>
        cause instanceof ChatGPTDesktopBridgeError
          ? cause
          : new ChatGPTDesktopBridgeError({
              kind: "unavailable",
              detail: "Unable to inspect ChatGPT Desktop.",
            }),
    }),
  send: streamSend,
});
