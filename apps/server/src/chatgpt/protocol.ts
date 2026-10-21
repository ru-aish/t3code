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
    // Walk source once so backticks inside SVG and SVG inside Markdown code fences
    // do not change how each other's boundaries are interpreted.
    const sections: Array<{ kind: "text" | "code" | "svg"; value: string }> = [];
    let cursor = 0;
    let plainStart = 0;
    while (cursor < displayText.length) {
      const nextTag = displayText.indexOf("<", cursor);
      const nextTick = displayText.indexOf("`", cursor);
      const nextTilde = displayText.indexOf("~", cursor);
      const nextCode =
        nextTick < 0 ? nextTilde : nextTilde < 0 ? nextTick : Math.min(nextTick, nextTilde);
      if (nextTag < 0 && nextCode < 0) break;
      if (nextCode >= 0 && (nextTag < 0 || nextCode < nextTag)) {
        const marker = displayText[nextCode]!;
        let runEnd = nextCode + 1;
        while (displayText[runEnd] === marker) runEnd++;
        const runLength = runEnd - nextCode;
        const lineStart = displayText.lastIndexOf("\n", nextCode - 1) + 1;
        const prefix = displayText.slice(lineStart, nextCode);
        const atFenceStart =
          runLength >= 3 &&
          prefix.length <= 3 &&
          /^ *$/.test(prefix) &&
          (marker === "~" ||
            !displayText
              .slice(
                runEnd,
                displayText.indexOf("\n", runEnd) < 0
                  ? displayText.length
                  : displayText.indexOf("\n", runEnd),
              )
              .includes("`"));
        let codeEnd = -1;
        if (atFenceStart) {
          // Fences close only at the start of a line with an equal-or-longer
          // run. Backticks inside JavaScript strings are not fence closers.
          let line = displayText.indexOf("\n", runEnd);
          while (line >= 0) {
            const start = line + 1;
            const lineEnd = displayText.indexOf("\n", start);
            const end = lineEnd < 0 ? displayText.length : lineEnd;
            const candidate = displayText.slice(start, end);
            const close = /^ {0,3}([`~]{3,})[ \t]*\r?$/.exec(candidate);
            if (close && close[1]![0] === marker && close[1]!.length >= runLength) {
              codeEnd = lineEnd < 0 ? end : lineEnd + 1;
              break;
            }
            line = lineEnd;
          }
          if (codeEnd < 0) codeEnd = displayText.length;
        } else if (marker === "`") {
          // An escaped opening delimiter is ordinary Markdown text. Once a
          // code span opens, backslashes are literal (even before its closer).
          let slashes = 0;
          for (let i = nextCode - 1; i >= 0 && displayText[i] === "\\"; i--) slashes++;
          if (slashes % 2 === 0) {
            let seek = runEnd;
            while ((seek = displayText.indexOf("`", seek)) >= 0) {
              let closeEnd = seek + 1;
              while (displayText[closeEnd] === "`") closeEnd++;
              if (closeEnd - seek === runLength) {
                codeEnd = closeEnd;
                break;
              }
              seek = closeEnd;
            }
          }
          // Preserve unfinished multiline code while new tokens stream in.
          if (codeEnd < 0 && runLength >= 3) codeEnd = displayText.length;
        }
        if (codeEnd < 0) {
          cursor = runEnd;
          continue;
        }
        if (plainStart < nextCode)
          sections.push({ kind: "text", value: displayText.slice(plainStart, nextCode) });
        sections.push({ kind: "code", value: displayText.slice(nextCode, codeEnd) });
        cursor = codeEnd;
        plainStart = cursor;
        continue;
      }
      if (displayText.startsWith("<!--", nextTag)) {
        const end = displayText.indexOf("-->", nextTag + 4);
        cursor = end < 0 ? displayText.length : end + 3;
        continue;
      }
      if (/^<button(?=[\s/>])/i.test(displayText.slice(nextTag, nextTag + 8))) {
        // Keep a complete DIL button together so inline-code ticks inside its
        // label do not split the markup before the Markdown button fallback.
        const buttonEnd = displayText.indexOf("</button>", nextTag);
        if (buttonEnd >= 0) {
          cursor = buttonEnd + "</button>".length;
          continue;
        }
      }
      if (!/^<svg(?=[\s/>])/i.test(displayText.slice(nextTag, nextTag + 5))) {
        cursor = nextTag + 1;
        continue;
      }
      let depth = 0;
      let svgEnd = -1;
      let position = nextTag;
      while (position < displayText.length) {
        const lt = displayText.indexOf("<", position);
        if (lt < 0) break;
        if (displayText.startsWith("<!--", lt)) {
          const end = displayText.indexOf("-->", lt + 4);
          if (end < 0) break;
          position = end + 3;
          continue;
        }
        if (displayText.startsWith("<![CDATA[", lt)) {
          const end = displayText.indexOf("]]>", lt + 9);
          if (end < 0) break;
          position = end + 3;
          continue;
        }
        const svgTag = /^<(\/?)svg(?=[\s/>])/i.exec(displayText.slice(lt, lt + 6));
        let quote: string | null = null;
        let tagEnd = -1;
        for (let i = lt + 1; i < displayText.length; i++) {
          const char = displayText[i];
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
        if (svgTag) {
          let last = tagEnd - 1;
          while (last > lt && /\s/.test(displayText[last]!)) last--;
          if (svgTag[1]) {
            depth--;
            if (depth === 0) {
              svgEnd = tagEnd + 1;
              break;
            }
          } else if (displayText[last] !== "/") {
            depth++;
          } else if (depth === 0) {
            svgEnd = tagEnd + 1;
            break;
          }
        }
        position = tagEnd + 1;
      }
      if (svgEnd < 0) {
        // An incomplete SVG has no independently renderable nested viewport.
        // Leave the unfinished fragment as text until the next stream update;
        // retrying every nested <svg> would scan the same suffix quadratically.
        break;
      }
      if (plainStart < nextTag)
        sections.push({ kind: "text", value: displayText.slice(plainStart, nextTag) });
      sections.push({ kind: "svg", value: displayText.slice(nextTag, svgEnd) });
      cursor = svgEnd;
      plainStart = cursor;
    }
    if (plainStart < displayText.length) {
      sections.push({ kind: "text", value: displayText.slice(plainStart) });
    }
    displayText = sections
      .map(({ kind, value }) => {
        if (kind === "code") return value;
        if (kind === "svg") {
          let longestTicks = 2;
          for (const match of value.matchAll(/`+/g)) {
            longestTicks = Math.max(longestTicks, match[0].length);
          }
          const fence = "`".repeat(longestTicks + 1);
          return `\n\n${fence}svg\n${value}\n${fence}\n\n`;
        }
        const buttons = value.replace(/<button\b[\s\S]*?<\/button>/g, (button) => {
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
