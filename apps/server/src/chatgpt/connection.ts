// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off preferSchemaOverJson:off -- Native CDP transport boundary; its public operations are lifted into Effect by the provider adapter.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { imageUploadDestination, normalizeProjects, normalizeStreamMessage } from "./protocol.ts";
import { rendererDiscovery } from "./rendererDiscovery.ts";
import { type ChatGPTWakeBridge, wakeBridgeInstructions } from "./wakeBridge.ts";

export type ChatGPTUpdate = {
  kind: "update" | "complete" | "error";
  requestId?: string | undefined;
  conversationId: string | null;
  messageId?: string | undefined;
  role?: string | undefined;
  channel?: string | undefined;
  recipient?: string | undefined;
  text?: string | undefined;
  status?: string | undefined;
  endTurn?: boolean | undefined;
  hidden?: boolean | undefined;
};
export type TerminalBinding = {
  thread_id: string;
  terminal_id: string;
  conversation_id: string | null;
  state: "idle" | "working" | "done";
  paused: number;
  epoch: number;
  cwd: string;
  model: string;
};
export type TerminalEvent = {
  seq: number;
  event_id: string;
  thread_id: string;
  kind: string;
  epoch: number;
  payload: {
    state?: string | undefined;
    paused?: boolean | undefined;
    prompt?: string | undefined;
    url?: string;
  };
};
export type ChatGPTModel = {
  slug: string;
  name?: string | undefined;
  is_default: boolean;
  is_available: boolean;
  thinking_efforts?: ReadonlyArray<string> | undefined;
};
export type ChatGPTImage = { id: string; name: string; mimeType: string; path: string };
type UploadedImage = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
};
export type CachedMessage = ChatGPTUpdate & { messageId: string; text: string };
type Cache = {
  conversationId: string | null;
  projectId?: string | null;
  uploads?: Record<string, UploadedImage>;
  messages: Record<string, CachedMessage>;
  dispatches: Record<
    string,
    { messageId: string; state: "prepared" | "dispatching" | "submitted" }
  >;
  handledEvents: string[];
};

export function stableMessageId(requestId: string): string {
  const hex = NodeCrypto.createHash("sha256").update(requestId).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function executionPrompt(
  terminalId: string,
  cwd: string,
  text: string,
  wakeBridge?: ChatGPTWakeBridge,
): string {
  const wakeInstructions = wakeBridge === undefined ? "" : wakeBridgeInstructions(wakeBridge);
  return `[T3 execution context]\nYour permanent Terminal MCP thread ID is: ${terminalId}\nWorkspace: ${JSON.stringify(cwd)}\nIf you use fedora_t3code tools, bootstrap and recover only with this exact ID and reuse it as session_id for every tool call. Never invent or substitute an ID. Only after using those tools, report verified completion with thread_task(action="complete", evidence=[...]), or call thread_task(action="wait", reason="...") if user input is required. Without fedora_t3code tool use, simply end your response normally.${wakeInstructions}\n[/T3 execution context]\n\n${text}`;
}

class Cdp {
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly socket: WebSocket;
  readonly onEvent: (method: string, params: unknown) => void;
  private constructor(socket: WebSocket, onEvent: (method: string, params: unknown) => void) {
    this.socket = socket;
    this.onEvent = onEvent;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending?.reject(new Error("ChatGPT renderer command failed"));
        else pending?.resolve(message.result);
      } else this.onEvent(message.method, message.params);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values())
        pending.reject(new Error("ChatGPT renderer disconnected"));
      this.pending.clear();
      onEvent("disconnected", {});
    });
  }
  static async connect(endpoint: string, onEvent: (method: string, params: unknown) => void) {
    const url = new URL(endpoint);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("ChatGPT CDP must be loopback");
    const response = await fetch(new URL("/json/list", url), {
      signal: AbortSignal.timeout(10_000),
    });
    const targets = (await response.json()) as Array<{
      type: string;
      url: string;
      webSocketDebuggerUrl?: string | undefined;
    }>;
    const target =
      targets.find(
        (target) =>
          target.type === "page" && /localhost:5175\/|127\.0\.0\.1:5175\//.test(target.url),
      ) ??
      targets.find((target) => target.type === "page" && target.url === "app://-/index.html") ??
      targets.find(
        (target) => target.type === "page" && target.url.startsWith("https://chatgpt.com/"),
      );
    if (!target?.webSocketDebuggerUrl)
      throw new Error("Authenticated ChatGPT renderer is unavailable");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Cannot connect to ChatGPT renderer")),
        { once: true },
      );
    });
    const cdp = new Cdp(socket, onEvent);
    await cdp.call("Runtime.enable", {});
    return cdp;
  }
  async call(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ChatGPT renderer command timed out"));
      }, 90_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const result = (await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as {
      exceptionDetails?: unknown;
      result?: { value?: T; subtype?: string };
    };
    if (
      (result as { error?: unknown }).error ||
      result.exceptionDetails ||
      result.result?.subtype === "error"
    )
      throw new Error("ChatGPT client operation failed");
    return result.result?.value as T;
  }
  close() {
    this.socket.close();
  }
}

export class ChatGPTConnection {
  private cdp: Cdp | undefined;
  private cache: Cache = { conversationId: null, messages: {}, dispatches: {}, handledEvents: [] };
  private writes = Promise.resolve();
  private binding = "__t3_chatgpt_" + NodeCrypto.randomUUID().replaceAll("-", "");
  private callback: ((update: ChatGPTUpdate) => void) | undefined;
  private deliveryBarrier = Promise.resolve();
  private closed = false;
  readonly cachePath: string;
  readonly options: {
    cdpEndpoint: string;
    controlEndpoint: string;
    token: string;
    environmentId: string;
    providerId: string;
    threadId: string;
    cacheDir: string;
  };
  constructor(options: {
    cdpEndpoint: string;
    controlEndpoint: string;
    token: string;
    environmentId: string;
    providerId: string;
    threadId: string;
    cacheDir: string;
  }) {
    this.options = options;
    this.cachePath = NodePath.join(
      options.cacheDir,
      `${NodeCrypto.createHash("sha256").update(options.threadId).digest("hex")}.json`,
    );
  }
  async load() {
    try {
      this.cache = JSON.parse(await NodeFSP.readFile(this.cachePath, "utf8")) as Cache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private persist() {
    const value = JSON.stringify(this.cache);
    this.writes = this.writes.then(async () => {
      await NodeFSP.mkdir(NodePath.dirname(this.cachePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.cachePath}.${NodeCrypto.randomUUID()}.tmp`;
      await NodeFSP.writeFile(temporary, value, { mode: 0o600 });
      await NodeFSP.rename(temporary, this.cachePath);
    });
    return this.writes;
  }
  async control<T>(
    action: string,
    body: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const endpoint = new URL(this.options.controlEndpoint);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))
      throw new Error("Terminal control plane must be loopback");
    const response = await fetch(new URL(`/v1/${action}`, endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.token}`,
      },
      body: JSON.stringify({
        threadId: this.options.threadId,
        environmentId: this.options.environmentId,
        providerId: this.options.providerId,
        ...body,
      }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Terminal MCP control request failed (${response.status})`);
    return (await response.json()) as T;
  }
  private async renderer() {
    if (this.cdp) return this.cdp;
    this.cdp = await Cdp.connect(this.options.cdpEndpoint, (method, raw) => {
      if (method === "disconnected") {
        this.cdp = undefined;
        if (!this.closed)
          this.callback?.({ kind: "error", conversationId: this.cache.conversationId });
        return;
      }
      const params = raw as { name: string; payload: string };
      if (method !== "Runtime.bindingCalled" || params.name !== this.binding) return;
      const update = JSON.parse(params.payload) as ChatGPTUpdate;
      this.acceptRendererUpdate(update);
    });
    await this.cdp.call("Runtime.addBinding", { name: this.binding });
    return this.cdp;
  }
  private acceptRendererUpdate(update: ChatGPTUpdate) {
    const conversationChanged =
      update.conversationId !== null && update.conversationId !== this.cache.conversationId;
    if (update.conversationId) this.cache.conversationId = update.conversationId;
    if (update.messageId && update.text !== undefined)
      this.cache.messages[update.messageId] = {
        ...update,
        messageId: update.messageId,
        text: update.text,
      };

    // Conversation identity must be durable before the update is exposed so
    // tool calls bind to the same upstream conversation after a restart. The
    // diagnostic message cache does not need to block every streamed token.
    if (conversationChanged) this.deliveryBarrier = this.persist().then(() => undefined);
    void this.deliveryBarrier
      .then(() => this.callback?.(update))
      .catch(() => {
        this.callback?.({ kind: "error", conversationId: this.cache.conversationId });
      });

    // Flush the accumulated diagnostic transcript at a stream boundary. Doing
    // this after delivery prevents a long queue of whole-cache writes from
    // delaying the provider's completion signal.
    if (!conversationChanged && (update.kind === "complete" || update.kind === "error")) {
      void this.persist().catch(() => {
        this.callback?.({ kind: "error", conversationId: this.cache.conversationId });
      });
    }
  }
  async models(): Promise<ChatGPTModel[]> {
    const cdp = await this.renderer();
    const models = await cdp.evaluate<ChatGPTModel[]>(
      `(async()=>{${rendererDiscovery}\nconst r=await resolveClient();return collectModels(await r.client.models()).models;})()`,
    );
    return models.filter((m) => m.is_available);
  }
  async projects() {
    const cdp = await this.renderer();
    return cdp.evaluate<{ id: string; name: string }[]>(`(async()=>{${rendererDiscovery}
      const r=await resolveClient();const all=[];let cursor=null;const seen=new Set();
      do{const page=await r.client.listProjects({limit:20,cursor,ownedOnly:false});all.push(...(${normalizeProjects.toString()})(page));const next=page.cursor||null;if(next&&seen.has(next))throw new Error('Repeated project cursor');if(next)seen.add(next);cursor=next;}while(cursor);
      return all;
    })()`);
  }
  async createProject(name: string) {
    if (!name.trim() || name.length > 200)
      throw new Error("Enter a project name of 1–200 characters");
    const cdp = await this.renderer();
    return cdp.evaluate<{ id: string; name: string }>(`(async()=>{${rendererDiscovery}
      const r=await resolveClient();const response=await r.client.createProject(${JSON.stringify(name.trim())});
      if(response.error||!response.resource)throw new Error('ChatGPT project creation failed');
      const resource=response.resource;const project=resource.gizmo?.gizmo||resource.gizmo||resource;
      const id=project.id;if(!id?.startsWith('g-p-'))throw new Error('Missing ChatGPT project identity');
      return {id,name:project.display?.name||project.name||${JSON.stringify(name.trim())}};
    })()`);
  }
  private async uploadImage(image: ChatGPTImage): Promise<UploadedImage> {
    const cached = this.cache.uploads?.[image.id];
    if (cached) return cached;
    const bytes = await NodeFSP.readFile(image.path);
    if (
      !bytes.length ||
      bytes.length > 20 * 1024 * 1024 ||
      !/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType)
    )
      throw new Error("ChatGPT images must be PNG, JPEG, WebP, or GIF up to 20 MiB");
    const cdp = await this.renderer();
    const file = { name: image.name, size: bytes.length, mimeType: image.mimeType };
    const dimensions = await cdp.evaluate<{ width: number; height: number }>(
      `new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(new Error('Invalid image'));image.src=${JSON.stringify("data:" + image.mimeType + ";base64," + bytes.toString("base64"))};})`,
    );
    const grant = await cdp.evaluate<{
      file_id: string;
      upload_url: string;
      upload_headers?: Record<string, string>;
    }>(
      `(async()=>{${rendererDiscovery}const r=await resolveClient();return r.client.createUpload(${JSON.stringify(file)});})()`,
    );
    if (!grant.file_id || !grant.upload_url)
      throw new Error("ChatGPT did not provide an image upload destination");
    const destination = imageUploadDestination(grant.upload_url, image.mimeType);
    const response = await fetch(destination.url, {
      method: "PUT",
      body: bytes,
      headers: { ...destination.headers, ...grant.upload_headers },
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`ChatGPT image upload failed (${response.status})`);
    await cdp.evaluate(
      `(async()=>{${rendererDiscovery}const r=await resolveClient();await r.client.finishUpload(${JSON.stringify({ ...file, id: grant.file_id })});return true;})()`,
    );
    const uploaded = { ...file, ...dimensions, id: grant.file_id };
    (this.cache.uploads ||= {})[image.id] = uploaded;
    await this.persist();
    return uploaded;
  }
  async adoptConversation(conversationId: string) {
    if (this.cache.conversationId && this.cache.conversationId !== conversationId)
      throw new Error("Conversation identity is immutable");
    this.cache.conversationId = conversationId;
    await this.persist();
  }
  async health() {
    await this.renderer();
  }
  get conversationId() {
    return this.cache.conversationId;
  }
  get messages() {
    return Object.values(this.cache.messages);
  }
  async isConversationIdle(): Promise<boolean> {
    if (!this.cache.conversationId) return false;
    const cdp = await this.renderer();
    return cdp.evaluate<boolean>(`(async()=>{${rendererDiscovery}
      const r=await resolveClient();const raw=await r.client.get(${JSON.stringify(this.cache.conversationId)});const c=raw.conversation||raw.data||raw;return c.async_status===null;
    })()`);
  }
  onUpdate(callback: (update: ChatGPTUpdate) => void) {
    this.callback = callback;
  }
  async send(
    requestId: string,
    text: string,
    model: string,
    cwd: string,
    effort?: string,
    images: ChatGPTImage[] = [],
    projectId?: string | null,
    wakeBridge?: ChatGPTWakeBridge,
  ) {
    let dispatch = this.cache.dispatches[requestId];
    if (dispatch?.state === "submitted") return;
    if (dispatch?.state === "dispatching")
      throw new Error("Previous ChatGPT submission is uncertain; reconcile before retrying");
    dispatch = { messageId: stableMessageId(requestId), state: "prepared" };
    this.cache.dispatches[requestId] = dispatch;
    await this.persist();
    const cdp = await this.renderer();
    const existing = this.cache.conversationId;
    if (projectId && !/^g-p-[a-zA-Z0-9-]+$/.test(projectId))
      throw new Error("Invalid ChatGPT project identity");
    if (
      this.cache.projectId !== undefined &&
      projectId !== undefined &&
      this.cache.projectId !== projectId
    )
      throw new Error(
        "This conversation is bound to another ChatGPT project. Start a new thread to change it.",
      );
    if (!existing && this.cache.projectId === undefined) this.cache.projectId = projectId ?? null;
    const uploaded = [];
    for (const image of images) uploaded.push(await this.uploadImage(image));
    // A continuation reads its canonical parent once. No transcript or stream-status polling.
    let parent: string | undefined;
    if (existing) {
      const snapshot = await cdp.evaluate<{ current_node: string; gizmo_id?: string }>(
        `(async()=>{${rendererDiscovery}\nconst r=await resolveClient();const raw=await r.client.get(${JSON.stringify(existing)});const c=raw.conversation||raw.data||raw;return {current_node:c.current_node,gizmo_id:c.gizmo_id};})()`,
      );
      if (!snapshot.current_node) throw new Error("Conversation parent could not be reconciled");
      parent = snapshot.current_node;
      const upstreamProject = snapshot.gizmo_id ?? null;
      if (this.cache.projectId !== undefined && this.cache.projectId !== upstreamProject)
        throw new Error("ChatGPT conversation project changed outside T3");
      if (projectId !== undefined && projectId !== upstreamProject)
        throw new Error("This conversation is bound to another ChatGPT project");
      this.cache.projectId = upstreamProject;
    }
    const request = {
      action: "next",
      model,
      ...(existing ? { conversation_id: existing, parent_message_id: parent } : {}),
      ...(effort ? { thinking_effort: effort } : {}),
      ...(this.cache.projectId
        ? {
            gizmo_id: this.cache.projectId,
            conversation_mode: { kind: "gizmo_interaction", gizmo_id: this.cache.projectId },
          }
        : {}),
      supported_encodings: ["v1"],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezone_offset_min: -new Date().getTimezoneOffset(),
      messages: [
        {
          id: dispatch.messageId,
          author: { role: "user" },
          content: {
            content_type: uploaded.length ? "multimodal_text" : "text",
            parts: [
              ...uploaded.map((image) => ({
                content_type: "image_asset_pointer",
                asset_pointer:
                  (image.id.startsWith("file_") ? "sediment://" : "file-service://") + image.id,
                width: image.width,
                height: image.height,
                size_bytes: image.size,
              })),
              executionPrompt(this.options.threadId, cwd, text, wakeBridge),
            ],
          },
          create_time: Date.now() / 1000,
          end_turn: null,
          metadata: uploaded.length
            ? {
                attachments: uploaded.map((image) => ({
                  id: image.id,
                  name: image.name,
                  mimeType: image.mimeType,
                  size: image.size,
                  width: image.width,
                  height: image.height,
                })),
              }
            : {},
          recipient: "all",
          status: "finished_successfully",
          weight: 1,
        },
      ],
    };
    dispatch.state = "dispatching";
    await this.persist();
    await cdp.evaluate(`(async()=>{${rendererDiscovery}
      const resolved=await resolveClient();
      const key=Symbol.for('t3.chatgpt.streams.v1');window[key] ||= new Map();
      const state={binding:${JSON.stringify(this.binding)},conversationId:${JSON.stringify(existing)},requestId:${JSON.stringify(requestId)},active:true};
      window[key].set(${JSON.stringify(this.options.threadId)},state);
      const emit=(kind,value)=>{
        const v=value&&typeof value==='object'?value:{};const candidate=v.message||v.data||v;const m=candidate.message||candidate;
        state.conversationId=v.conversation_id||v.conversationId||candidate.conversation_id||candidate.conversationId||state.conversationId;
        const normalized=(${normalizeStreamMessage.toString()})(value);
        if(kind==='complete'||kind==='error')state.active=false;
        const update={kind,requestId:state.requestId,conversationId:state.conversationId,...normalized};
        state.lastUpdate=update;
        if(typeof window[state.binding]==='function')window[state.binding](JSON.stringify(update));
      };
      try {
        const handle=resolved.client.startCompletionStream({request:${JSON.stringify(request)},onUpdate:v=>emit('update',v),onComplete:v=>emit('complete',v),onError:v=>emit('error',v)});
        Promise.resolve(handle).then(h=>{state.handle=h;},e=>emit('error',e));
        return {submitted:true};
      }catch(e){emit('error',e);throw e;}
    })()`);
    dispatch.state = "submitted";
    await this.persist();
  }
  async stop() {
    if (!this.cache.conversationId)
      throw new Error("Cannot stop a generation before its conversation identity is known");
    const cdp = await this.renderer();
    await cdp.evaluate(
      `(async()=>{${rendererDiscovery}\nconst r=await resolveClient();if(typeof r.client.stopCompletion!=='function')throw new Error('Stop unavailable');await r.client.stopCompletion({conversationId:${JSON.stringify(this.cache.conversationId)}});return true;})()`,
    );
  }
  async *terminalEvents(signal: AbortSignal): AsyncGenerator<TerminalEvent> {
    let after = 0;
    while (!signal.aborted) {
      const url = new URL("/v1/events", this.options.controlEndpoint);
      url.searchParams.set("environmentId", this.options.environmentId);
      url.searchParams.set("providerId", this.options.providerId);
      url.searchParams.set("afterSeq", String(after));
      url.searchParams.set("waitSeconds", "25");
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${this.options.token}` },
        signal,
      });
      if (!response.ok) throw new Error("Terminal MCP event connection failed");
      const body = (await response.json()) as { events: TerminalEvent[] };
      for (const event of body.events) {
        after = event.seq;
        if (event.thread_id !== this.options.threadId) continue;
        if (this.cache.handledEvents.includes(event.event_id)) {
          await this.control("ack", { eventId: event.event_id });
          continue;
        }
        yield event;
      }
    }
  }
  async acknowledge(event: TerminalEvent) {
    this.cache.handledEvents.push(event.event_id);
    await this.persist();
    await this.control("ack", { eventId: event.event_id });
  }
  close() {
    this.closed = true;
    this.cdp?.close();
  }
}
