/**
 * The only module that knows ChatGPT Desktop's CDP/renderer details. Nothing
 * outside this adapter may depend on DOM selectors, renderer state, or CDP.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const RESPONSE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const SETTLED_POLLS = 3;
const BACKEND_CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
  return (
    targets.find(
      (candidate) =>
        usable(candidate) &&
        /^http:\/\/(127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d+)?\//iu.test(
          candidate.url ?? "",
        ) &&
        !/[?&]initialRoute=%2Fchatgpt%2Fquick-chat-prewarm/iu.test(candidate.url ?? ""),
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
const rendererProbe = `(() => { const surface = document.querySelector(${JSON.stringify(QUICK_CHAT)}); const editor = document.querySelector(${JSON.stringify(EDITOR)}); return { composer: Boolean(surface && editor), empty: Boolean(editor && !(editor.textContent || '').trim()) }; })()`;
const quickChatButton = `[...document.querySelectorAll('button')].find((candidate) => (candidate.textContent || '').trim().split('\\n')[0]?.trim() === 'Chat')`;
const mutateEditor = (text: string) =>
  `(() => { const editor = document.querySelector(${JSON.stringify(EDITOR)}); if (!(editor instanceof HTMLElement)) return { ok: false, reason: 'editor' }; editor.focus(); const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(true); selection?.removeAllRanges(); selection?.addRange(range); const inserted = document.execCommand('insertText', false, ${JSON.stringify(text)}); if (!inserted) editor.textContent = ${JSON.stringify(text)}; editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} })); return { ok: true }; })()`;
const sendEnabled = `(() => { const send = document.querySelector(${JSON.stringify(SEND)}); return Boolean(send && !send.disabled && send.getAttribute('aria-disabled') !== 'true'); })()`;
const injectImages = (
  images: ReadonlyArray<{
    readonly name: string;
    readonly mimeType: string;
    readonly base64: string;
  }>,
) =>
  `(() => { const input = document.querySelector(${JSON.stringify(`${QUICK_CHAT} input[type="file"][aria-label="Attach files"]`)}); if (!(input instanceof HTMLInputElement)) return { ok: false, reason: 'attachment-input' }; const transfer = new DataTransfer(); for (const image of ${JSON.stringify(images)}) { const binary = atob(image.base64); transfer.items.add(new File([Uint8Array.from(binary, c => c.charCodeAt(0))], image.name, { type: image.mimeType })); } input.files = transfer.files; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; })()`;
const attachmentReady = `(() => { const surface = document.querySelector(${JSON.stringify(QUICK_CHAT)}); return Boolean(surface?.querySelector('[data-testid*="attachment" i], [aria-label*="Remove" i]')); })()`;
const readTurns = `(() => { const surface = document.querySelector(${JSON.stringify(QUICK_CHAT)}); if (!surface) return []; const units = [...surface.querySelectorAll('[data-content-search-unit-key]')]; const modern = units.map(unit => { const id = unit.getAttribute('data-content-search-unit-key') || ''; const match = id.match(/:(user|assistant)$/); return match ? { id, role: match[1], text: unit.textContent || '' } : null; }).filter(Boolean); if (modern.length) return modern; return [...surface.querySelectorAll('[data-message-author-role]')].map((unit, index) => ({ id: unit.getAttribute('data-message-id') || \`legacy:\${index}:\${unit.getAttribute('data-message-author-role') || ''}\`, role: unit.getAttribute('data-message-author-role') || '', text: unit.textContent || '' })); })()`;
const isGenerating = `(() => Boolean(document.querySelector(${JSON.stringify(`${QUICK_CHAT} button[aria-label="Stop"]`)})))()`;
const queryCache = `(() => { const fibers = []; for (const node of [document.documentElement, ...[...document.querySelectorAll('*')].slice(0, 300)]) { for (const key of Object.keys(node)) if (key.startsWith('__reactFiber$')) fibers.push(node[key]); } const seen = new Set(), queue = fibers; const enqueue = (value) => { if (value && (typeof value === 'object' || typeof value === 'function') && !seen.has(value)) queue.push(value); }; while (queue.length && seen.size < 2_000) { const value = queue.shift(); if (!value || seen.has(value)) continue; seen.add(value); if (typeof value.getQueryCache === 'function') { try { return value.getQueryCache().getAll().map((query) => ({ key: query.queryKey, data: query.state?.data, updatedAt: query.state?.dataUpdatedAt })); } catch {} } for (const key of ['return', 'child', 'sibling', 'stateNode', 'memoizedState', 'memoizedProps', 'dependencies', 'next', 'context', '_currentValue', '_currentValue2']) { try { enqueue(value[key]); } catch {} } } return []; })()`;

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
      !BACKEND_CONVERSATION_ID.test(query.key[1])
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

export function verifyOpenedConversation(
  queries: ReadonlyArray<QueryRecord>,
  id: string,
  visibleTurns: ReadonlyArray<RendererTurn>,
): boolean {
  const query = queries.find(
    (candidate) => candidate.key[0] === "chatgpt-conversation" && candidate.key[1] === id,
  );
  if (!query) return false;
  const expected = conversationMessages(query.data);
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

type ConversationHistoryEntry = { readonly id: string; readonly title: string };

/** Flatten every page of React Query's infinite conversation-history result. */
export function findConversationHistoryEntry(
  queries: ReadonlyArray<QueryRecord>,
  id: string,
): ConversationHistoryEntry | undefined {
  if (!BACKEND_CONVERSATION_ID.test(id)) return undefined;
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
  requireEmpty: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const probe = (await evaluateWithRetry(evaluate, rendererProbe, signal)) as RendererProbe;
    if (probe?.composer && (!requireEmpty || probe.empty)) return;
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
const historyEntry = (title: string) =>
  `(() => { const root = document.querySelector(${JSON.stringify(QUICK_CHAT)}); return root ? [...root.querySelectorAll('button,[role="menuitem"]')].find((item) => { const label = item.getAttribute('aria-label'); const rect = item.getBoundingClientRect(); return (label === ${JSON.stringify(title)} || (item.textContent || '').trim() === ${JSON.stringify(title)}) && !item.hidden && item.getAttribute('aria-hidden') !== 'true' && rect.width > 0 && rect.height > 0; }) : null; })()`;

async function ensureQuickChat(
  cdp: Pick<Awaited<ReturnType<typeof openCdp>>, "evaluate" | "trustedClickExpression">,
  signal?: AbortSignal,
): Promise<void> {
  const probe = (await evaluateWithRetry(cdp.evaluate, rendererProbe, signal)) as RendererProbe;
  if (!probe?.composer) await cdp.trustedClickExpression(quickChatButton, signal);
  await waitForRenderer(cdp.evaluate, false, signal);
}

async function configureModel(
  cdp: Awaited<ReturnType<typeof openCdp>>,
  input: Parameters<ChatGPTDesktopBridgeShape["send"]>[0],
): Promise<void> {
  const { trustedClick, trustedClickExpression, evaluate } = cdp;
  const trigger = `${QUICK_CHAT} button[aria-label="Select ChatGPT model"]`;
  await trustedClick(trigger, input.signal);
  const state = (await evaluateWithRetry(evaluate, modelMenuState, input.signal)) as {
    selected?: string;
    version?: string;
  } | null;
  const effort = input.reasoningEffort
    ? input.reasoningEffort.charAt(0).toUpperCase() + input.reasoningEffort.slice(1)
    : undefined;
  const effortNeedsChanging = effort !== undefined && state?.selected !== effort;
  if (effortNeedsChanging) await trustedClickExpression(visibleMenuItem(effort), input.signal);
  const label = input.model ? modelLabel[input.model] : undefined;
  if (label && state?.version !== label) {
    if (effortNeedsChanging) await trustedClick(trigger, input.signal);
    await trustedClickExpression(modelSubmenuTrigger, input.signal);
    await trustedClickExpression(visibleMenuItem(label, true), input.signal);
  }
}

/** Kept as an async generator so cancellation only owns the active response, never ChatGPT's tools. */
async function* streamSend(
  input: Parameters<ChatGPTDesktopBridgeShape["send"]>[0],
): AsyncIterable<{ conversationId: string; text: string }> {
  const cdp = await openCdp(input.endpoint, input.signal);
  try {
    const { evaluate, trustedClick, trustedClickExpression } = cdp;
    await ensureQuickChat(cdp, input.signal);
    if (input.conversationId) {
      const history = findConversationHistoryEntry(
        (await evaluateWithRetry(evaluate, queryCache, input.signal)) as QueryRecord[],
        input.conversationId,
      );
      if (!history)
        throw new ChatGPTDesktopBridgeError({
          kind: "incompatible",
          detail: "The requested ChatGPT conversation was not present in quick-chat history.",
        });
      await trustedClickExpression(historyTrigger, input.signal);
      await trustedClickExpression(historyEntry(history.title), input.signal);
      await waitForRenderer(evaluate, false, input.signal);
      const verified = verifyOpenedConversation(
        (await evaluateWithRetry(evaluate, queryCache, input.signal)) as QueryRecord[],
        input.conversationId,
        (await evaluateWithRetry(evaluate, readTurns, input.signal)) as RendererTurn[],
      );
      if (!verified)
        throw new ChatGPTDesktopBridgeError({
          kind: "incompatible",
          detail: "ChatGPT Desktop could not verify the requested saved conversation.",
        });
    } else {
      await trustedClick(NEW_CHAT, input.signal);
      await waitForRenderer(evaluate, true, input.signal);
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
    await trustedClick(SEND, input.signal);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    let conversationId = input.conversationId ?? "";
    let previous = "";
    let responseStarted = false;
    let sawGenerating = false;
    let stable = 0;
    while (Date.now() < deadline) {
      if (input.signal?.aborted) throw interrupted();
      conversationId ||=
        discoverStableConversationId(
          (await evaluateWithRetry(evaluate, queryCache, input.signal)) as QueryRecord[],
          input.text,
        ) ?? "";
      const turns = assistantTurns(
        (await evaluateWithRetry(evaluate, readTurns, input.signal)) as RendererTurn[],
      );
      const newest = turns.toReversed().find((turn) => !before.has(turn.id));
      const text = newest?.text ?? "";
      const generating = Boolean(await evaluateWithRetry(evaluate, isGenerating, input.signal));
      if (text.length > 0) {
        responseStarted = true;
        if (text.length > previous.length) {
          if (!BACKEND_CONVERSATION_ID.test(conversationId)) {
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
        const cdp = await openCdp(endpoint);
        try {
          await ensureQuickChat(cdp);
        } finally {
          cdp.close();
        }
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
  conversationMessages,
  discoverStableConversationId,
  discoverTarget,
  findConversationHistoryEntry,
  openCdp,
  parseRoleUnits,
  streamSend,
  mutateEditor,
  expressions: {
    attachmentReady,
    historyEntry,
    historyTrigger,
    injectImages,
    modelMenuState,
    modelSubmenuTrigger,
    visibleMenuItem,
  },
  configureModel,
  ensureQuickChat,
  selectDesktopTarget,
  validateEndpoint,
  validateWebSocketEndpoint,
  verifyOpenedConversation,
  waitForRenderer,
};
