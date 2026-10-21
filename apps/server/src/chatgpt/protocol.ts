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
    /<(?:box|row|col|card|button|badge|icon|text|title|svg)\b/.test(displayText)
  ) {
    // Some ChatGPT surfaces omit the fallback. Turn its presentation-only DIL
    // into readable Markdown without altering fenced source-code examples.
    displayText = displayText
      .split(/(```[\s\S]*?```)/g)
      .map((section, index) => {
        if (index % 2 === 1) return section;
        const chunks: { value: string; svg: boolean }[] = [];
        let cursor = 0;
        let svgStart = -1;
        let depth = 0;
        const svgTag = /<\/?svg\b/gi;
        let match: RegExpExecArray | null;
        while ((match = svgTag.exec(section)) !== null) {
          const opening = !match[0].startsWith("</");
          if (depth === 0 && !opening) continue;
          // Scan the tag boundary without mistaking '>' inside quoted attributes
          // for the end of a nested SVG opening tag.
          let quote: string | null = null;
          let tagEnd = -1;
          for (let i = match.index + match[0].length; i < section.length; i++) {
            const char = section[i];
            if (quote) {
              if (char === quote) quote = null;
            } else if (char === '"' || char === "'") {
              quote = char;
            } else if (char === ">") {
              tagEnd = i;
              break;
            }
          }
          if (tagEnd < 0) break;
          svgTag.lastIndex = tagEnd + 1;
          if (opening) {
            if (depth === 0) svgStart = match.index;
            if (section[tagEnd - 1] !== "/") depth++;
          } else {
            depth--;
          }
          if (depth === 0 && svgStart >= 0) {
            if (svgStart > cursor)
              chunks.push({ value: section.slice(cursor, svgStart), svg: false });
            chunks.push({ value: section.slice(svgStart, tagEnd + 1), svg: true });
            cursor = tagEnd + 1;
            svgStart = -1;
          }
        }
        chunks.push({ value: section.slice(cursor), svg: false });
        return chunks
          .map(({ value: part, svg }) => {
            if (svg) {
              let longestTicks = 2;
              for (const match of part.matchAll(/`+/g)) {
                longestTicks = Math.max(longestTicks, match[0].length);
              }
              const fence = "`".repeat(longestTicks + 1);
              return `\n\n${fence}svg\n${part}\n${fence}\n\n`;
            }
            const buttons = part.replace(/<button\b[\s\S]*?<\/button>/g, (button) => {
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
          .join("");
      })
      .join("")
      .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n");
  }
  return {
    messageId: message.id,
    role: message.author?.role,
    channel: message.channel,
    recipient: message.recipient,
    hidden: metadata.is_visually_hidden_from_conversation === true,
    text: displayText,
    status: message.status,
    endTurn: message.end_turn,
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
