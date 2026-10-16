import type { ChatGPTUpdate } from "./connection.ts";

// Runs inside the authenticated renderer as well as in focused protocol tests.
// Keep self-contained so its serialized function needs no module globals.
export function normalizeStreamMessage(
  raw: unknown,
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
    };
  };
  const value = raw as Message;
  const candidate = value?.message || value?.data || value || {};
  const message = candidate.message || candidate;
  const metadata = message.metadata || {};
  return {
    messageId: message.id,
    role: message.author?.role,
    channel: message.channel,
    recipient: message.recipient,
    hidden: metadata.is_visually_hidden_from_conversation === true,
    text: Array.isArray(message.content?.parts)
      ? message.content.parts.filter((part: unknown) => typeof part === "string").join("\n") ||
        metadata.model_dil_v2?.fallbackMarkdown ||
        ""
      : message.content?.text || metadata.model_dil_v2?.fallbackMarkdown || "",
    status: message.status,
    endTurn: message.end_turn,
  };
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
