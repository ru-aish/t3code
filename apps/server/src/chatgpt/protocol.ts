import type { ChatGPTUpdate } from "./connection.ts";

// This also runs in the authenticated renderer during transcript recovery.
export function isTerminalToolCall(
  message: Pick<ChatGPTUpdate, "role" | "recipient" | "text">,
  terminalId: string,
): boolean {
  if (message.role !== "assistant") return false;
  if (message.recipient?.includes("fedora_t3code")) return true;
  if (message.recipient !== "api_tool.call_tool" || !message.text) return false;
  if (message.text.includes("fedora_t3code")) return true;
  try {
    const call = JSON.parse(message.text) as {
      path?: unknown;
      args?: { thread_id?: unknown; session_id?: unknown };
    };
    // ChatGPT can replace the connector's friendly name with an opaque app ID.
    // Match the scoped Terminal invocation rather than hard-coding that alias.
    return (
      typeof call.path === "string" &&
      call.path.startsWith("/asdk_app_") &&
      (call.args?.thread_id === terminalId || call.args?.session_id === terminalId)
    );
  } catch {
    return false;
  }
}

// Runs inside the authenticated renderer as well as in focused protocol tests.
// Keep self-contained so its serialized function needs no module globals.
export function normalizeStreamMessage(
  raw: unknown,
  terminalId?: string,
): Omit<ChatGPTUpdate, "kind" | "conversationId"> {
  type Message = {
    message?: Message;
    data?: Message;
    id?: string;
    author?: { role?: string };
    channel?: string;
    recipient?: string;
    status?: string;
    end_turn?: boolean;
    content?: { parts?: unknown[]; text?: string };
    metadata?: {
      is_visually_hidden_from_conversation?: boolean;
      model_dil_v2?: { fallbackMarkdown?: string };
      jit_plugin_data?: { from_server?: unknown };
      elicitation_metadata?: { plugin_data?: { from_server?: unknown } };
    };
  };
  const value = raw as Message;
  const candidate = value?.message || value?.data || value || {};
  const message = candidate.message || candidate;
  const metadata = message.metadata || {};
  const originalText = Array.isArray(message.content?.parts)
    ? message.content.parts.filter((part: unknown) => typeof part === "string").join("\n")
    : message.content?.text || "";
  const fallback = metadata.model_dil_v2?.fallbackMarkdown;
  const isFinal = message.author?.role === "assistant" && message.channel === "final";
  // T3 renders Markdown, not ChatGPT's DIL components. Prefer the supplied
  // Markdown fallback even when content.parts contains rich UI source.
  let displayText = (isFinal && fallback?.trim()) || originalText || fallback || "";
  if (
    isFinal &&
    !fallback?.trim() &&
    /<(?:box|row|col|card|button|badge|icon|text|title)\b/.test(displayText)
  ) {
    // Some ChatGPT surfaces omit the fallback. Turn its presentation-only DIL
    // into readable Markdown without altering fenced source-code examples.
    displayText = displayText
      .split(/(```[\s\S]*?```)/g)
      .map((section, index) => {
        if (index % 2 === 1) return section;
        const buttons = section.replace(/<button\b[\s\S]*?<\/button>/g, (button) => {
          const url = button.match(/GenUI\.openUrl\(\s*["'](https?:\/\/[^"']+)["']\s*\)/)?.[1];
          const openEnd =
            button.indexOf("}>") >= 0 ? button.indexOf("}>") + 2 : button.indexOf(">") + 1;
          const label = button
            .slice(openEnd, button.lastIndexOf("</button>"))
            .replace(/<[^>]+>/g, "")
            .trim();
          return url ? "[" + (label || "Open link") + "](" + url + ")" : label;
        });
        return buttons.replace(
          /<\/?(?:box|row|col|card|badge|icon|text|title|caption|grid|grid-item|divider|spacer|button)\b[^>]*\/?>/g,
          "",
        );
      })
      .join("")
      .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n");
  }
  const approvalServer = (metadata.jit_plugin_data?.from_server ??
    metadata.elicitation_metadata?.plugin_data?.from_server) as
    | {
        type?: string;
        body?: {
          codex_mcp_elicitation?: { kind?: string; status?: string };
          connector_id?: unknown;
          connector_name?: unknown;
          link_id?: unknown;
          params?: { path?: unknown; args?: { thread_id?: unknown; session_id?: unknown } };
          actions?: Array<{ always_allow?: { target_message_id?: unknown } }>;
        };
      }
    | undefined;
  const approvalBody = approvalServer?.body;
  const connectorId =
    typeof approvalBody?.connector_id === "string" ? approvalBody.connector_id : "";
  const linkId = typeof approvalBody?.link_id === "string" ? approvalBody.link_id : "";
  const call = approvalBody?.params;
  const callIds = [call?.args?.thread_id, call?.args?.session_id].filter((id) => id !== undefined);
  const route = typeof call?.path === "string" ? call.path.split("/") : [];
  // Recreated Fedora connections have different opaque IDs. Check the
  // server's connector name together with the canonical route and thread IDs.
  const isScopedTerminalCall =
    typeof terminalId === "string" &&
    terminalId.length > 0 &&
    callIds.length > 0 &&
    callIds.every((id) => id === terminalId) &&
    (approvalBody?.connector_name === "fedora" ||
      approvalBody?.connector_name === "fedora_t3code") &&
    connectorId.startsWith("asdk_app_") &&
    linkId.startsWith("link_") &&
    route.length === 4 &&
    route[1] === connectorId &&
    route[2] === linkId &&
    /^[a-zA-Z0-9_]+$/.test(route[3] ?? "");
  const offersAlwaysAllow =
    approvalBody?.actions?.some(
      (action) => action.always_allow?.target_message_id === message.id,
    ) === true;
  const fedoraApproval =
    message.author?.role === "tool" &&
    approvalServer?.type === "confirm_action" &&
    approvalBody?.codex_mcp_elicitation?.kind === "mcpToolCall" &&
    approvalBody.codex_mcp_elicitation.status === "pending" &&
    isScopedTerminalCall &&
    offersAlwaysAllow &&
    typeof message.id === "string" &&
    connectorId.length > 0 &&
    linkId.length > 0
      ? { messageId: message.id, connectorId, linkId }
      : undefined;
  return {
    messageId: message.id,
    role: message.author?.role,
    channel: message.channel,
    recipient: message.recipient,
    hidden: metadata.is_visually_hidden_from_conversation === true,
    text: displayText,
    status: message.status,
    endTurn: message.end_turn,
    ...(fedoraApproval ? { fedoraApproval } : {}),
  };
}

// ChatGPT can complete its streamed final answer in multiple message blocks.
// It also sends invisible copies of earlier blocks. Keep new blocks without
// repeating text that is already present in the accumulated answer.
export function mergeFinalAnswer(previous: string | undefined, incoming: string): string {
  if (!previous || incoming.includes(previous)) return incoming;
  if (previous.includes(incoming)) return previous;
  // Continuation blocks sometimes repeat only the tail of an earlier block.
  for (let length = Math.min(previous.length, incoming.length); length >= 8; length--) {
    if (previous.endsWith(incoming.slice(0, length))) return previous + incoming.slice(length);
  }
  return previous.trimEnd() + "\n\n" + incoming.trimStart();
}

export function normalizeProjects(raw: unknown): { id: string; name: string }[] {
  const value = raw as {
    items?: Array<{
      gizmo?: { gizmo?: { id?: string; display?: { name?: string }; is_archived?: boolean } };
    }>;
  };
  return (value.items ?? []).flatMap((item) => {
    const project = item.gizmo?.gizmo;
    return project?.id?.startsWith("g-p-") && project.display?.name && !project.is_archived
      ? [{ id: project.id, name: project.display.name }]
      : [];
  });
}

export function imageUploadDestination(signedUrl: string, mimeType: string) {
  const destination = new URL(signedUrl);
  const embedded = destination.searchParams.get("upload_url");
  const url = embedded ? new URL(embedded) : destination;
  if (url.protocol !== "https:") throw new Error("ChatGPT upload requires HTTPS");
  // The consumer app uses custom oaiusercontent.com domains for Azure blobs.
  // Detect AWS signing rather than assuming Azure's public hostname.
  const aws = url.searchParams.has("X-Amz-Algorithm") || url.searchParams.has("AWSAccessKeyId");
  return {
    url,
    headers: {
      "content-type": mimeType,
      ...(!aws
        ? {
            "x-ms-blob-type": "BlockBlob",
            "x-ms-version": "2020-04-08",
            "x-ms-blob-content-type": mimeType,
          }
        : {}),
    },
  };
}
