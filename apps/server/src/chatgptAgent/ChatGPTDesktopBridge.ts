// @effect-diagnostics globalTimers:off globalFetch:off globalDate:off
/**
 * The only module that knows ChatGPT Desktop's CDP/renderer details. Nothing
 * outside this adapter may depend on DOM selectors, renderer state, or CDP.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const RENDERER_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const THOUGHT_STREAM_INTERVAL_MS = 2_000;
const BACKEND_CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isBackendConversationId(value: string): boolean {
  return BACKEND_CONVERSATION_ID.test(value);
}

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

const isChatGPTDesktopBridgeError = Schema.is(ChatGPTDesktopBridgeError);

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
    /** Desktop menu version id; `desktop` is normalized by the router. */
    readonly model?: "latest" | "5.5" | "5.4" | "5.3" | "o3";
    readonly reasoningEffort?: "instant" | "medium" | "high";
    /** Image bytes are kept server-side until injected into the desktop renderer. */
    readonly images?: ReadonlyArray<{
      readonly name: string;
      readonly mimeType: string;
      readonly base64: string;
    }>;
    readonly signal?: AbortSignal;
  }) => AsyncIterable<{
    readonly conversationId: string;
    readonly kind: "assistant" | "thinking";
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

export type RendererTurn = { readonly id: string; readonly text: string; readonly role: string };
export type RendererRoleUnit = { readonly key: string; readonly text: string };
type RendererProbe = {
  readonly composer?: boolean;
  readonly empty?: boolean;
  readonly turnCount?: number;
};
type CdpTarget = {
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
};
type QueryRecord = {
  readonly key: ReadonlyArray<unknown>;
  readonly data: unknown;
  readonly updatedAt?: number;
};
type RendererReasoning = {
  readonly id?: string;
  readonly text?: string;
  readonly completed?: boolean;
};
type ClientConversationSnapshot = {
  readonly id: string;
  readonly title: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  readonly complete: boolean;
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
  let targets: CdpTarget[];
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
  const target = selectDesktopTarget(targets);
  if (!target?.webSocketDebuggerUrl)
    throw new ChatGPTDesktopBridgeError({
      kind: "incompatible",
      detail: "CDP is reachable, but no logged-in ChatGPT renderer target was found.",
    });
  return { webSocketDebuggerUrl: validateWebSocketEndpoint(target.webSocketDebuggerUrl) };
}

/** Prefer the authenticated local desktop renderer; prewarm pages have no usable quick-chat state. */
export function selectDesktopTarget(targets: ReadonlyArray<CdpTarget>): CdpTarget | undefined {
  const usable = (candidate: CdpTarget) =>
    candidate.type === "page" && Boolean(candidate.webSocketDebuggerUrl);
  const isLocalRenderer = (candidate: CdpTarget) =>
    usable(candidate) &&
    /^http:\/\/(127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d+)?\//iu.test(candidate.url ?? "");
  const isStandaloneQuickChatWindow = (candidate: CdpTarget) =>
    /[?&]initialRoute=%2Fchatgpt%2Fquick-chat/iu.test(candidate.url ?? "");
  return (
    targets.find(
      (candidate) =>
        isLocalRenderer(candidate) &&
        /[?&]mcpAppSandboxDevtools=1(?:[&#]|$)/iu.test(candidate.url ?? ""),
    ) ??
    targets.find(
      (candidate) => isLocalRenderer(candidate) && !isStandaloneQuickChatWindow(candidate),
    ) ??
    targets.find(
      (candidate) =>
        usable(candidate) &&
        /https:\/\/(chatgpt\.com|chat\.openai\.com)(?:\/|$)/iu.test(candidate.url ?? ""),
    )
  );
}

async function openCdp(
  endpoint: string,
  signal?: AbortSignal,
  timeouts: { readonly connectMs?: number; readonly commandMs?: number } = {},
): Promise<{
  evaluate: (expression: string, signal?: AbortSignal) => Promise<unknown>;
  trustedClick: (selector: string, signal?: AbortSignal) => Promise<void>;
  trustedClickExpression: (expression: string, signal?: AbortSignal) => Promise<void>;
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
  const command = (method: string, params: Record<string, unknown>, commandSignal?: AbortSignal) =>
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
                detail: `ChatGPT Desktop did not complete CDP command ${method} in time.`,
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
            method,
            params,
          }),
        );
      } catch {
        finish(() => reject(unavailable("Could not send a CDP command to ChatGPT Desktop.")));
      }
    });
  const evaluate = (expression: string, commandSignal?: AbortSignal) =>
    command(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      commandSignal,
    );
  const dispatchTrustedClick = async (
    point: { x?: number; y?: number } | null,
    description: string,
    commandSignal?: AbortSignal,
  ) => {
    if (!point || typeof point.x !== "number" || typeof point.y !== "number")
      throw new ChatGPTDesktopBridgeError({
        kind: "incompatible",
        detail: `Could not find clickable ${description}.`,
      });
    await command(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 },
      commandSignal,
    );
    await command(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 },
      commandSignal,
    );
  };
  const trustedClickExpression = async (expression: string, commandSignal?: AbortSignal) =>
    dispatchTrustedClick(
      (await evaluate(
        `(() => { const element = (${expression}); if (!(element instanceof Element)) return null; const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null; })()`,
        commandSignal,
      )) as { x?: number; y?: number } | null,
      "renderer control",
      commandSignal,
    );
  const trustedClick = async (selector: string, commandSignal?: AbortSignal) =>
    trustedClickExpression(`document.querySelector(${JSON.stringify(selector)})`, commandSignal);
  return { evaluate, trustedClick, trustedClickExpression, close };
}

const QUICK_CHAT = '[data-pip-obstacle="quick-chat"]';
const EDITOR = `${QUICK_CHAT} [contenteditable="true"][aria-label="Message ChatGPT"]`;
const SEND = `${QUICK_CHAT} button[aria-label="Send"]`;
const NEW_CHAT = `${QUICK_CHAT} button[aria-label="New chat"]`;
const ADD_FILES = `${QUICK_CHAT} button[aria-label="Add files and more"]`;
const rendererProbe = `(() => { const surface = document.querySelector(${JSON.stringify(QUICK_CHAT)}); const editor = document.querySelector(${JSON.stringify(EDITOR)}); const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !element.hidden && element.getAttribute('aria-hidden') !== 'true'; }; const turnCount = surface ? [...surface.querySelectorAll('[data-content-search-unit-key], [data-message-author-role]')].filter(visible).length : 0; return { composer: Boolean(surface && editor && visible(editor)), empty: Boolean(editor && !(editor.textContent || '').trim()), turnCount }; })()`;
const quickChatButton = `[...document.querySelectorAll('button')].find((candidate) => { const text = (candidate.textContent || '').trim().replace(/\\s+/g, ' '); const rect = candidate.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && (text === 'Chat' || text.startsWith('ChatCtrl+') || text.startsWith('Chat Ctrl+')); })`;
const mutateEditor = (text: string) =>
  `(() => { const editor = document.querySelector(${JSON.stringify(EDITOR)}); if (!(editor instanceof HTMLElement)) return { ok: false, reason: 'editor' }; editor.focus(); const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(true); selection?.removeAllRanges(); selection?.addRange(range); const inserted = document.execCommand('insertText', false, ${JSON.stringify(text)}); if (!inserted) editor.textContent = ${JSON.stringify(text)}; editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} })); return { ok: true }; })()`;
const sendEnabled = `(() => { const send = document.querySelector(${JSON.stringify(SEND)}); return Boolean(send && !send.disabled && send.getAttribute('aria-disabled') !== 'true'); })()`;
const activateSend = `(() => { const send = document.querySelector(${JSON.stringify(SEND)}); if (!(send instanceof HTMLButtonElement)) return { ok: false, reason: 'missing' }; if (send.disabled || send.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' }; send.click(); return { ok: true }; })()`;
const sendAcknowledged = `(() => { const root = document.querySelector(${JSON.stringify(QUICK_CHAT)}); const editor = document.querySelector(${JSON.stringify(EDITOR)}); const stop = root ? [...root.querySelectorAll('button[aria-label]')].find((button) => (button.getAttribute('aria-label') || '').toLowerCase().startsWith('stop')) : null; const visible = (element) => { if (!element) return false; const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !element.hidden && element.getAttribute('aria-hidden') !== 'true'; }; return Boolean(editor && !(editor.textContent || '').trim()) || visible(stop); })()`;
const injectImages = (
  images: ReadonlyArray<{
    readonly name: string;
    readonly mimeType: string;
    readonly base64: string;
  }>,
) =>
  `(() => { const input = document.querySelector(${JSON.stringify(`${QUICK_CHAT} input[type="file"][aria-label="Attach files"]`)}); if (!(input instanceof HTMLInputElement)) return { ok: false, reason: 'attachment-input' }; const transfer = new DataTransfer(); for (const image of ${JSON.stringify(images)}) { const binary = atob(image.base64); transfer.items.add(new File([Uint8Array.from(binary, c => c.charCodeAt(0))], image.name, { type: image.mimeType })); } input.files = transfer.files; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; })()`;
const attachmentReady = `(() => { const surface = document.querySelector(${JSON.stringify(QUICK_CHAT)}); return Boolean(surface?.querySelector('[data-testid*="attachment" i], [aria-label*="Remove" i]')); })()`;
const readTurns = `(() => { const surface = document.querySelector(${JSON.stringify(QUICK_CHAT)}); if (!surface) return []; const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !element.hidden && element.getAttribute('aria-hidden') !== 'true'; }; const units = [...surface.querySelectorAll('[data-content-search-unit-key]')].filter(visible); const modern = units.map(unit => { const id = unit.getAttribute('data-content-search-unit-key') || ''; const match = id.match(/:(user|assistant)$/); return match ? { id, role: match[1], text: unit.textContent || '' } : null; }).filter(Boolean); if (modern.length) return modern; return [...surface.querySelectorAll('[data-message-author-role]')].filter(visible).map((unit, index) => ({ id: unit.getAttribute('data-message-id') || \`legacy:\${index}:\${unit.getAttribute('data-message-author-role') || ''}\`, role: unit.getAttribute('data-message-author-role') || '', text: unit.textContent || '' })); })()`;
const readLatestReasoning = `(() => { const surface = document.querySelector(${JSON.stringify(QUICK_CHAT)}); if (!surface) return null; const turns = [...surface.querySelectorAll('[data-chatgpt-conversation-turn="true"]')]; const turn = turns.at(-1) || surface; const body = turn.querySelector('[data-testid="exploration-accordion-body"]'); if (!(body instanceof HTMLElement)) return null; const text = (body.innerText || body.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim(); const toggle = body.parentElement?.querySelector('button[aria-expanded]'); const label = (toggle?.textContent || '').trim(); return { id: turn.getAttribute('data-chatgpt-conversation-turn-id') || String(turns.length - 1), text, completed: /^Thought\\b/i.test(label) }; })()`;
const isGenerating = `(() => { const surface = document.querySelector(${JSON.stringify(QUICK_CHAT)}); if (!surface) return false; const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !element.hidden && element.getAttribute('aria-hidden') !== 'true'; }; return [...surface.querySelectorAll('button[aria-label], [role="status"][aria-busy="true"]')].some((element) => visible(element) && ((element.getAttribute('aria-label') || '').toLowerCase().startsWith('stop') || element.getAttribute('aria-busy') === 'true')); })()`;
const responseComplete = `(() => { const surface = document.querySelector(${JSON.stringify(QUICK_CHAT)}); if (!surface) return false; const turns = [...surface.querySelectorAll('[data-chatgpt-conversation-turn="true"]')]; const turn = turns.at(-1); if (!turn) return false; const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !element.hidden && element.getAttribute('aria-hidden') !== 'true'; }; return [...turn.querySelectorAll('button[aria-label]')].some((button) => visible(button) && /^(Copy|Copy message|Good response|Bad response)$/i.test(button.getAttribute('aria-label') || '')); })()`;
const queryCache = `(() => { const fibers = []; for (const node of [document.documentElement, ...[...document.querySelectorAll('*')].slice(0, 300)]) { for (const key of Object.keys(node)) if (key.startsWith('__reactFiber$')) fibers.push(node[key]); } const seen = new Set(), queue = fibers; const enqueue = (value) => { if (value && (typeof value === 'object' || typeof value === 'function') && !seen.has(value)) queue.push(value); }; while (queue.length && seen.size < 2_000) { const value = queue.shift(); if (!value || seen.has(value)) continue; seen.add(value); if (typeof value.getQueryCache === 'function') { try { return value.getQueryCache().getAll().map((query) => ({ key: query.queryKey, data: query.state?.data, updatedAt: query.state?.dataUpdatedAt })); } catch {} } for (const key of ['return', 'child', 'sibling', 'stateNode', 'memoizedState', 'memoizedProps', 'dependencies', 'next', 'context', '_currentValue', '_currentValue2']) { try { enqueue(value[key]); } catch {} } } return []; })()`;

const conversationClientPrelude = `
  const cacheKey = Symbol.for('t3.chatgptAgent.conversationClient');
  const isConversationClient = (value) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    let own = [], proto = [];
    try { own = Reflect.ownKeys(value); } catch {}
    try { const parent = Object.getPrototypeOf(value); proto = parent ? Reflect.ownKeys(parent) : []; } catch {}
    const names = new Set([...own, ...proto].filter((key) => typeof key === 'string'));
    return names.has('startCompletionStream') && names.has('list') && names.has('get');
  };
  const findConversationClient = () => {
    const cached = globalThis[cacheKey];
    if (isConversationClient(cached)) return cached;
    const queue = [];
    for (const node of [document.documentElement, ...document.querySelectorAll('*')]) {
      for (const key of Object.keys(node)) if (key.startsWith('__reactFiber$')) queue.push(node[key]);
    }
    const seen = new Set();
    while (queue.length && seen.size < 100000) {
      const value = queue.shift();
      if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) continue;
      seen.add(value);
      if (isConversationClient(value)) {
        try { globalThis[cacheKey] = value; } catch {}
        return value;
      }
      if (value instanceof Map) for (const entry of value.values()) queue.push(entry);
      for (const key of ['return', 'child', 'sibling', 'stateNode', 'memoizedState', 'memoizedProps', 'dependencies', 'next', 'context', '_currentValue', '_currentValue2', 'current', 'node', 'signalBindings', 'init', 'value']) {
        try {
          const child = value[key];
          if (child && (typeof child === 'object' || typeof child === 'function')) queue.push(child);
        } catch {}
      }
    }
    return null;
  };
  const messageText = (value) => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    if (typeof value.content === 'string') return value.content;
    if (typeof value.text === 'string') return value.text;
    const parts = value.content && typeof value.content === 'object' ? value.content.parts : null;
    return Array.isArray(parts) && parts.every((part) => typeof part === 'string') ? parts.join('\\n') : '';
  };
  const orderedMessages = (data) => {
    if (!data || typeof data !== 'object' || !data.mapping || typeof data.current_node !== 'string') return [];
    const result = [], visited = new Set();
    let id = data.current_node;
    while (typeof id === 'string' && !visited.has(id) && visited.size < 512) {
      visited.add(id);
      const node = data.mapping[id];
      if (!node) break;
      const role = node.message?.author?.role;
      const text = messageText(node.message);
      if ((role === 'user' || role === 'assistant') && text.trim()) result.push({ role, text });
      id = typeof node.parent === 'string' ? node.parent : null;
    }
    return result.reverse();
  };
`;

function withConversationClient(body: string): string {
  return `(async () => { ${conversationClientPrelude} const client = findConversationClient(); if (!client) return null; ${body} })()`;
}

function conversationSnapshotFromClient(id: string): string {
  return withConversationClient(`
    try {
      const data = await client.get(${JSON.stringify(id)});
      const conversationId = typeof data?.conversation_id === 'string' ? data.conversation_id : '';
      if (!conversationId) return null;
      const current = typeof data.current_node === 'string' ? data.mapping?.[data.current_node]?.message : null;
      const status = typeof current?.status === 'string' ? current.status : '';
      const complete = current?.author?.role === 'assistant' &&
        (current?.end_turn === true || status === 'finished_successfully' || status === 'complete');
      return {
        id: conversationId,
        title: typeof data.title === 'string' ? data.title : '',
        messages: orderedMessages(data),
        complete,
      };
    } catch { return null; }
  `);
}

function discoverConversationIdFromClient(sentText: string): string {
  return withConversationClient(`
    try {
      const prefix = 'View chat history, current chat:';
      const titleButton = [...document.querySelectorAll(${JSON.stringify(`${QUICK_CHAT} button[aria-label^="View chat history, current chat:"]`)})]
        .find((button) => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      const currentTitle = (titleButton?.getAttribute('aria-label') || '').slice(prefix.length).trim();
      const response = await client.list({ expand: false, limit: 20 });
      const items = Array.isArray(response?.items) ? response.items : Array.isArray(response) ? response : [];
      if (currentTitle) {
        const matching = items
          .filter((item) => item?.title === currentTitle)
          .sort((a, b) => Number(b?.update_time || 0) - Number(a?.update_time || 0))[0];
        const matchingId = typeof matching?.id === 'string'
          ? matching.id
          : typeof matching?.conversation_id === 'string'
            ? matching.conversation_id
            : '';
        if (matchingId) return matchingId;
      }
      // The title can lag for the first few polls. Verify only the newest
      // candidate rather than loading an entire history page serially.
      const newest = items[0];
      const newestId = typeof newest?.id === 'string'
        ? newest.id
        : typeof newest?.conversation_id === 'string'
          ? newest.conversation_id
          : '';
      if (!newestId) return null;
      const data = await client.get(newestId);
      return orderedMessages(data).some(
        (message) => message.role === 'user' && message.text === ${JSON.stringify(sentText)},
      )
        ? (typeof data?.conversation_id === 'string' ? data.conversation_id : newestId)
        : null;
    } catch { return null; }
  `);
}

function assistantTurns(turns: ReadonlyArray<RendererTurn>): ReadonlyArray<RendererTurn> {
  return turns.filter((turn) => turn.role === "assistant" && turn.text.trim().length > 0);
}

/** Converts desktop quick-chat units to stable message ids without using turn wrappers. */
export function parseRoleUnits(
  units: ReadonlyArray<RendererRoleUnit>,
): ReadonlyArray<RendererTurn> {
  return units.flatMap((unit) => {
    const match = unit.key.match(/:(user|assistant)$/u);
    return match ? [{ id: unit.key, role: match[1]!, text: unit.text }] : [];
  });
}

function textFromMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.content === "string") return record.content;
  if (typeof record.text === "string") return record.text;
  if (record.content && typeof record.content === "object") {
    const parts = (record.content as { parts?: unknown }).parts;
    if (Array.isArray(parts) && parts.every((part) => typeof part === "string"))
      return parts.join("\n");
  }
  return undefined;
}

type ConversationNode = { readonly parent?: unknown; readonly message?: unknown };

/** Read a React Query conversation in its actual current-node order, not object insertion order. */
export function conversationMessages(
  data: unknown,
): ReadonlyArray<{ readonly role: string; readonly text: string }> {
  const record = data as {
    current_node?: unknown;
    mapping?: Record<string, ConversationNode>;
  } | null;
  if (!record?.mapping || typeof record.current_node !== "string") return [];
  const result: Array<{ readonly role: string; readonly text: string }> = [];
  const seen = new Set<string>();
  let id: string | null = record.current_node;
  while (id && !seen.has(id) && seen.size < 512) {
    seen.add(id);
    const node: ConversationNode | undefined = record.mapping[id];
    if (!node) break;
    const message = node.message as { author?: { role?: unknown } } | undefined;
    const role = message?.author?.role;
    const text = textFromMessage(message);
    if ((role === "user" || role === "assistant") && text?.trim()) result.push({ role, text });
    id = typeof node.parent === "string" ? node.parent : null;
  }
  return result.toReversed();
}

/** Finds the backend id from React Query data, never from a local quick-chat URL. */
export function discoverStableConversationId(
  queries: ReadonlyArray<QueryRecord>,
  sentText: string,
): string | undefined {
  const matches: Array<{ id: string; updatedAt: number }> = [];
  for (const query of queries) {
    if (
      query.key[0] !== "chatgpt-conversation" ||
      typeof query.key[1] !== "string" ||
      !isBackendConversationId(query.key[1])
    )
      continue;
    const data = query.data as { mapping?: Record<string, unknown>; messages?: unknown } | null;
    const messages = data?.mapping
      ? conversationMessages(data).map(({ role, text }) => ({
          role,
          message: { author: { role }, content: text },
        }))
      : Array.isArray(data?.messages)
        ? data.messages
        : [];
    if (
      messages.some((message) => {
        const record = message as {
          message?: unknown;
          role?: unknown;
          author?: { role?: unknown };
        };
        const candidate = record.message ?? message;
        const role =
          record.role ??
          record.author?.role ??
          (candidate as { author?: { role?: unknown } })?.author?.role;
        return role === "user" && textFromMessage(candidate) === sentText;
      })
    )
      matches.push({ id: query.key[1], updatedAt: query.updatedAt ?? 0 });
  }
  return matches.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id;
}

function verifyOpenedMessages(
  expected: ReadonlyArray<{ readonly role: string; readonly text: string }>,
  visibleTurns: ReadonlyArray<RendererTurn>,
): boolean {
  const actual = visibleTurns
    .filter((turn) => (turn.role === "user" || turn.role === "assistant") && turn.text.trim())
    .map(({ role, text }) => ({ role, text }));
  const tailLength = Math.min(2, expected.length, actual.length);
  if (!tailLength) return false;
  return expected.slice(-tailLength).every((message, index) => {
    const visible = actual.slice(-tailLength)[index];
    return visible?.role === message.role && visible.text === message.text;
  });
}

export function verifyOpenedConversation(
  queries: ReadonlyArray<QueryRecord>,
  id: string,
  visibleTurns: ReadonlyArray<RendererTurn>,
): boolean {
  const query = queries.find(
    (candidate) => candidate.key[0] === "chatgpt-conversation" && candidate.key[1] === id,
  );
  return query ? verifyOpenedMessages(conversationMessages(query.data), visibleTurns) : false;
}

type ConversationHistoryEntry = { readonly id: string; readonly title: string };

/** Flatten every page of React Query's infinite conversation-history result. */
export function findConversationHistoryEntry(
  queries: ReadonlyArray<QueryRecord>,
  id: string,
): ConversationHistoryEntry | undefined {
  if (!isBackendConversationId(id)) return undefined;
  for (const query of queries) {
    if (query.key[0] !== "chatgpt-conversations") continue;
    const data = query.data as { pages?: unknown; items?: unknown; conversations?: unknown } | null;
    const pages = Array.isArray(data?.pages) ? data.pages : [data];
    for (const page of pages) {
      const items = Array.isArray((page as { items?: unknown } | null)?.items)
        ? ((page as { items: unknown[] }).items ?? [])
        : Array.isArray(data?.conversations)
          ? data.conversations
          : Array.isArray(data?.items)
            ? data.items
            : [];
      for (const item of items) {
        const record = item as { id?: unknown; conversation_id?: unknown; title?: unknown };
        if ((record.id === id || record.conversation_id === id) && typeof record.title === "string")
          return { id, title: record.title };
      }
    }
  }
  return undefined;
}

function contextWasReplaced(error: unknown): boolean {
  return (
    isChatGPTDesktopBridgeError(error) &&
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
  requireEmpty: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + RENDERER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const probe = (await evaluateWithRetry(evaluate, rendererProbe, signal)) as RendererProbe;
    if (probe?.composer && (!requireEmpty || (probe.empty && (probe.turnCount ?? 0) === 0))) return;
    await abortableDelay(POLL_INTERVAL_MS, signal);
  }
  throw new ChatGPTDesktopBridgeError({
    kind: "timeout",
    detail: requireEmpty
      ? "Timed out opening a new ChatGPT conversation."
      : "Timed out waiting for the ChatGPT renderer.",
  });
}

const modelLabel: Record<
  NonNullable<Parameters<ChatGPTDesktopBridgeShape["send"]>[0]["model"]>,
  string
> = { latest: "GPT-5.6 Sol", "5.5": "GPT-5.5", "5.4": "GPT-5.4", "5.3": "GPT-5.3", o3: "o3" };

const visibleMenuItem = (text: string, submenu = false) =>
  `(() => { const menus = [...document.querySelectorAll('[role="menu"]')].filter((menu) => { const rect = menu.getBoundingClientRect(); return !menu.hidden && menu.getAttribute('aria-hidden') !== 'true' && rect.width > 0 && rect.height > 0; }); const menu = ${submenu ? "menus.at(-1)" : "menus[0]"}; return menu ? [...menu.querySelectorAll('[role="menuitem"]')].find((item) => (item.textContent || '').trim() === ${JSON.stringify(text)}) : null; })()`;
const modelMenuState = `(() => { const menus = [...document.querySelectorAll('[role="menu"]')].filter((menu) => { const rect = menu.getBoundingClientRect(); return !menu.hidden && menu.getAttribute('aria-hidden') !== 'true' && rect.width > 0 && rect.height > 0; }); const outer = menus[0]; if (!outer) return null; const selected = [...outer.querySelectorAll('[role="menuitem"][data-chatgpt-model-selected="true"]')].map((item) => (item.textContent || '').trim()).find(Boolean) || ''; const version = [...outer.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')].map((item) => (item.textContent || '').trim()).find(Boolean) || ''; return { selected, version }; })()`;
const modelSubmenuTrigger = `(() => { const menus = [...document.querySelectorAll('[role="menu"]')].filter((menu) => { const rect = menu.getBoundingClientRect(); return !menu.hidden && menu.getAttribute('aria-hidden') !== 'true' && rect.width > 0 && rect.height > 0; }); const outer = menus[0]; return outer ? [...outer.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')].find((item) => { const rect = item.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }) : null; })()`;
const historyTrigger = `(() => [...document.querySelectorAll(${JSON.stringify(`${QUICK_CHAT} button[aria-label]`)})].find((button) => { const label = button.getAttribute('aria-label') || ''; const rect = button.getBoundingClientRect(); return label.startsWith('View chat history, current chat:') && rect.width > 0 && rect.height > 0; }) || null)()`;
const historyTriggerVisible = `Boolean(${historyTrigger})`;
const historyEntry = (title: string) =>
  `(() => { const root = document.querySelector(${JSON.stringify(QUICK_CHAT)}); return root ? [...root.querySelectorAll('button,[role="menuitem"]')].find((item) => { const label = item.getAttribute('aria-label'); const rect = item.getBoundingClientRect(); return (label === ${JSON.stringify(title)} || (item.textContent || '').trim() === ${JSON.stringify(title)}) && !item.hidden && item.getAttribute('aria-hidden') !== 'true' && rect.width > 0 && rect.height > 0; }) : null; })()`;

async function clickExpressionWhenReady(
  cdp: Pick<Awaited<ReturnType<typeof openCdp>>, "trustedClickExpression">,
  expression: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await cdp.trustedClickExpression(expression, signal);
      return;
    } catch (error) {
      if (
        !isChatGPTDesktopBridgeError(error) ||
        error.kind !== "incompatible" ||
        !error.detail.startsWith("Could not find clickable renderer control")
      )
        throw error;
      await abortableDelay(POLL_INTERVAL_MS, signal);
    }
  }
  throw new ChatGPTDesktopBridgeError({
    kind: "timeout",
    detail: "Timed out waiting for a ChatGPT Desktop renderer control.",
  });
}

async function waitForModelMenuState(
  evaluate: (expression: string, signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<{ readonly selected?: string; readonly version?: string }> {
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = (await evaluateWithRetry(evaluate, modelMenuState, signal)) as {
      selected?: string;
      version?: string;
    } | null;
    if (state) return state;
    await abortableDelay(POLL_INTERVAL_MS, signal);
  }
  throw new ChatGPTDesktopBridgeError({
    kind: "timeout",
    detail: "Timed out opening the ChatGPT Desktop model menu.",
  });
}

async function ensureQuickChat(
  cdp: Pick<Awaited<ReturnType<typeof openCdp>>, "evaluate" | "trustedClickExpression">,
  signal?: AbortSignal,
): Promise<void> {
  const probe = (await evaluateWithRetry(cdp.evaluate, rendererProbe, signal)) as RendererProbe;
  if (!probe?.composer) await clickExpressionWhenReady(cdp, quickChatButton, signal);
  await waitForRenderer(cdp.evaluate, false, signal);
}

async function prepareNewConversation(
  cdp: Pick<Awaited<ReturnType<typeof openCdp>>, "evaluate" | "trustedClick">,
  signal?: AbortSignal,
): Promise<void> {
  const probe = (await evaluateWithRetry(cdp.evaluate, rendererProbe, signal)) as RendererProbe;
  if (probe?.composer && probe.empty && (probe.turnCount ?? 0) === 0) return;
  await cdp.trustedClick(NEW_CHAT, signal);
  await waitForRenderer(cdp.evaluate, true, signal);
}

async function waitForConversation(
  evaluate: (expression: string, signal?: AbortSignal) => Promise<unknown>,
  expected: ReadonlyArray<{ readonly role: string; readonly text: string }>,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const turns = (await evaluateWithRetry(evaluate, readTurns, signal)) as RendererTurn[];
    if (verifyOpenedMessages(expected, turns)) return;
    await abortableDelay(POLL_INTERVAL_MS, signal);
  }
  throw new ChatGPTDesktopBridgeError({
    kind: "incompatible",
    detail: "ChatGPT Desktop could not verify the requested saved conversation.",
  });
}

async function configureModel(
  cdp: Awaited<ReturnType<typeof openCdp>>,
  input: Parameters<ChatGPTDesktopBridgeShape["send"]>[0],
): Promise<void> {
  const { evaluate } = cdp;
  const trigger = `${QUICK_CHAT} button[aria-label="Select ChatGPT model"]`;
  const triggerExpression = `document.querySelector(${JSON.stringify(trigger)})`;
  let state = (await evaluateWithRetry(evaluate, modelMenuState, input.signal)) as {
    selected?: string;
    version?: string;
  } | null;
  if (!state) {
    await clickExpressionWhenReady(cdp, triggerExpression, input.signal);
    state = await waitForModelMenuState(evaluate, input.signal);
  }
  const effort = input.reasoningEffort
    ? input.reasoningEffort.charAt(0).toUpperCase() + input.reasoningEffort.slice(1)
    : undefined;
  const effortNeedsChanging = effort !== undefined && state.selected !== effort;
  if (effortNeedsChanging)
    await clickExpressionWhenReady(cdp, visibleMenuItem(effort), input.signal);
  const label = input.model ? modelLabel[input.model] : undefined;
  if (label && state.version !== label) {
    if (effortNeedsChanging) await clickExpressionWhenReady(cdp, triggerExpression, input.signal);
    await clickExpressionWhenReady(cdp, modelSubmenuTrigger, input.signal);
    await clickExpressionWhenReady(cdp, visibleMenuItem(label, true), input.signal);
  }
}

async function submitMessage(
  evaluate: (expression: string, signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  let activationTimeout: ChatGPTDesktopBridgeError | undefined;
  let result: { ok?: boolean; reason?: string } | undefined;
  try {
    result = (await evaluate(activateSend, signal)) as typeof result;
  } catch (error) {
    if (!isChatGPTDesktopBridgeError(error) || error.kind !== "timeout") throw error;
    activationTimeout = error;
  }

  if (result && !result.ok)
    throw new ChatGPTDesktopBridgeError({
      kind: "incompatible",
      detail:
        result.reason === "disabled"
          ? "ChatGPT Desktop disabled Send before submission."
          : "ChatGPT Desktop does not expose a supported Send control.",
    });

  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  while (!(await evaluateWithRetry(evaluate, sendAcknowledged, signal))) {
    if (Date.now() >= deadline) {
      if (activationTimeout) throw activationTimeout;
      throw new ChatGPTDesktopBridgeError({
        kind: "timeout",
        detail: "ChatGPT Desktop did not acknowledge the submitted message.",
      });
    }
    await abortableDelay(POLL_INTERVAL_MS, signal);
  }
}

/** Kept as an async generator so cancellation only owns the active response, never ChatGPT's tools. */
async function* streamSend(input: Parameters<ChatGPTDesktopBridgeShape["send"]>[0]): AsyncIterable<{
  conversationId: string;
  kind: "assistant" | "thinking";
  text: string;
}> {
  const cdp = await openCdp(input.endpoint, input.signal);
  try {
    const { evaluate, trustedClick, trustedClickExpression } = cdp;
    await ensureQuickChat(cdp, input.signal);
    if (input.conversationId) {
      let title = "";
      let expected: ReadonlyArray<{ readonly role: string; readonly text: string }> = [];
      const snapshot = (await evaluateWithRetry(
        evaluate,
        conversationSnapshotFromClient(input.conversationId),
        input.signal,
      )) as ClientConversationSnapshot | null;
      if (
        snapshot?.id === input.conversationId &&
        isBackendConversationId(snapshot.id) &&
        snapshot.title &&
        snapshot.messages.length > 0
      ) {
        title = snapshot.title;
        expected = snapshot.messages;
      } else {
        const queries = (await evaluateWithRetry(
          evaluate,
          queryCache,
          input.signal,
        )) as QueryRecord[];
        const history = findConversationHistoryEntry(queries, input.conversationId);
        const query = queries.find(
          (candidate) =>
            candidate.key[0] === "chatgpt-conversation" &&
            candidate.key[1] === input.conversationId,
        );
        if (history && query) {
          title = history.title;
          expected = conversationMessages(query.data);
        }
      }
      if (!title || expected.length === 0)
        throw new ChatGPTDesktopBridgeError({
          kind: "incompatible",
          detail: "The requested ChatGPT conversation was not present in quick-chat history.",
        });
      const currentTurns = (await evaluateWithRetry(
        evaluate,
        readTurns,
        input.signal,
      )) as RendererTurn[];
      if (!verifyOpenedMessages(expected, currentTurns)) {
        if (await evaluateWithRetry(evaluate, historyTriggerVisible, input.signal))
          await trustedClickExpression(historyTrigger, input.signal);
        await trustedClickExpression(historyEntry(title), input.signal);
        await waitForConversation(evaluate, expected, input.signal);
      }
    } else {
      await prepareNewConversation(cdp, input.signal);
    }
    await configureModel(cdp, input);
    const before = new Set(
      assistantTurns(
        (await evaluateWithRetry(evaluate, readTurns, input.signal)) as RendererTurn[],
      ).map((turn) => turn.id),
    );
    if ((input.images?.length ?? 0) > 0) {
      await trustedClick(ADD_FILES, input.signal);
      const attached = (await evaluateWithRetry(
        evaluate,
        injectImages(input.images ?? []),
        input.signal,
      )) as { ok?: boolean; reason?: string };
      if (!attached.ok)
        throw new ChatGPTDesktopBridgeError({
          kind: "incompatible",
          detail: "ChatGPT renderer does not expose a supported image attachment control.",
        });
      const attachmentDeadline = Date.now() + COMMAND_TIMEOUT_MS;
      while (!(await evaluateWithRetry(evaluate, attachmentReady, input.signal))) {
        if (Date.now() >= attachmentDeadline)
          throw new ChatGPTDesktopBridgeError({
            kind: "timeout",
            detail: "ChatGPT Desktop did not acknowledge the image attachment.",
          });
        await abortableDelay(POLL_INTERVAL_MS, input.signal);
      }
    }
    const sent = (await evaluateWithRetry(evaluate, mutateEditor(input.text), input.signal)) as {
      ok?: boolean;
      reason?: string;
    };
    if (!sent?.ok)
      throw new ChatGPTDesktopBridgeError({
        kind: "incompatible",
        detail: "ChatGPT renderer does not expose a supported message editor.",
      });
    const sendDeadline = Date.now() + COMMAND_TIMEOUT_MS;
    while (!(await evaluateWithRetry(evaluate, sendEnabled, input.signal))) {
      if (Date.now() >= sendDeadline)
        throw new ChatGPTDesktopBridgeError({
          kind: "timeout",
          detail: "ChatGPT Desktop did not enable Send after editing the message.",
        });
      await abortableDelay(POLL_INTERVAL_MS, input.signal);
    }
    const reasoningBefore = (await evaluateWithRetry(
      evaluate,
      readLatestReasoning,
      input.signal,
    )) as RendererReasoning | null;
    await submitMessage(evaluate, input.signal);
    let conversationId = input.conversationId ?? "";
    let previousAssistantText = "";
    const baselineReasoningText = reasoningBefore?.text ?? "";
    const baselineReasoningId = reasoningBefore?.id ?? "";
    let lastYieldedReasoningText = "";
    let lastThoughtYieldAt = 0;
    let nextClientProbeAt = 0;
    let clientSnapshot: ClientConversationSnapshot | null = null;
    let responseStarted = false;

    // A ChatGPT Agent turn is intentionally unbounded. Long-running tasks may
    // take hours; cancellation, an explicit renderer failure, or a completed
    // response ends the stream instead of an arbitrary wall-clock deadline.
    while (true) {
      if (input.signal?.aborted) throw interrupted();
      const nowMs = Date.now();
      if (nowMs >= nextClientProbeAt) {
        nextClientProbeAt = nowMs + 1_000;
        if (!conversationId) {
          const clientId = await evaluateWithRetry(
            evaluate,
            discoverConversationIdFromClient(input.text),
            input.signal,
          );
          if (typeof clientId === "string" && isBackendConversationId(clientId))
            conversationId = clientId;
          else
            conversationId =
              discoverStableConversationId(
                (await evaluateWithRetry(evaluate, queryCache, input.signal)) as QueryRecord[],
                input.text,
              ) ?? "";
        }
        if (isBackendConversationId(conversationId)) {
          const snapshot = await evaluateWithRetry(
            evaluate,
            conversationSnapshotFromClient(conversationId),
            input.signal,
          );
          clientSnapshot = snapshot as ClientConversationSnapshot | null;
        }
      }

      const reasoning = (await evaluateWithRetry(
        evaluate,
        readLatestReasoning,
        input.signal,
      )) as RendererReasoning | null;
      const reasoningText = reasoning?.text?.trim() ?? "";
      const reasoningId = reasoning?.id ?? "";
      const isCurrentTurnReasoning =
        reasoningText.length > 0 &&
        (reasoningId !== baselineReasoningId || reasoningText !== baselineReasoningText);
      const shouldYieldThought =
        isCurrentTurnReasoning &&
        reasoningText !== lastYieldedReasoningText &&
        isBackendConversationId(conversationId) &&
        (reasoning?.completed === true || nowMs - lastThoughtYieldAt >= THOUGHT_STREAM_INTERVAL_MS);
      if (shouldYieldThought) {
        yield { conversationId, kind: "thinking", text: reasoningText };
        lastYieldedReasoningText = reasoningText;
        lastThoughtYieldAt = nowMs;
      }

      const turns = assistantTurns(
        (await evaluateWithRetry(evaluate, readTurns, input.signal)) as RendererTurn[],
      );
      const newest = turns.toReversed().find((turn) => !before.has(turn.id));
      const domAssistantText = newest?.text ?? "";
      const snapshotMessages = clientSnapshot?.messages ?? [];
      const sentMessageIndex = snapshotMessages.findLastIndex(
        (message) => message.role === "user" && message.text === input.text,
      );
      const snapshotAssistantText =
        sentMessageIndex >= 0
          ? (snapshotMessages
              .slice(sentMessageIndex + 1)
              .toReversed()
              .find((message) => message.role === "assistant")?.text ?? "")
          : "";
      const assistantText =
        snapshotAssistantText.length > domAssistantText.length
          ? snapshotAssistantText
          : domAssistantText;
      if (assistantText.length > 0) {
        responseStarted = true;
        if (
          assistantText.length > previousAssistantText.length &&
          isBackendConversationId(conversationId)
        ) {
          yield {
            conversationId,
            kind: "assistant",
            text: assistantText.slice(previousAssistantText.length),
          };
          previousAssistantText = assistantText;
        }
      }

      const generating = Boolean(await evaluateWithRetry(evaluate, isGenerating, input.signal));
      const completedInDom = Boolean(
        await evaluateWithRetry(evaluate, responseComplete, input.signal),
      );
      if (responseStarted && !generating && (clientSnapshot?.complete === true || completedInDom))
        return;
      await abortableDelay(POLL_INTERVAL_MS, input.signal);
    }
  } finally {
    cdp.close();
  }
}

export const ChatGPTDesktopBridgeLive = Layer.succeed(ChatGPTDesktopBridge, {
  health: (endpoint) =>
    Effect.tryPromise({
      try: async () => {
        const cdp = await openCdp(endpoint);
        try {
          await ensureQuickChat(cdp);
        } finally {
          cdp.close();
        }
        return { compatible: true, detail: "Connected to ChatGPT Desktop." };
      },
      catch: (cause) =>
        isChatGPTDesktopBridgeError(cause)
          ? cause
          : unavailable("Unable to inspect ChatGPT Desktop."),
    }),
  send: streamSend,
});

/** Narrow test seam for CDP transport and renderer-state behavior. */
export const ChatGPTDesktopBridgeTest = {
  assistantTurns,
  conversationMessages,
  conversationSnapshotFromClient,
  discoverStableConversationId,
  discoverTarget,
  findConversationHistoryEntry,
  openCdp,
  parseRoleUnits,
  streamSend,
  mutateEditor,
  submitMessage,
  expressions: {
    activateSend,
    attachmentReady,
    historyEntry,
    historyTrigger,
    injectImages,
    isGenerating,
    modelMenuState,
    modelSubmenuTrigger,
    readLatestReasoning,
    responseComplete,
    sendAcknowledged,
    visibleMenuItem,
  },
  configureModel,
  ensureQuickChat,
  prepareNewConversation,
  selectDesktopTarget,
  validateEndpoint,
  validateWebSocketEndpoint,
  verifyOpenedConversation,
  waitForRenderer,
};
