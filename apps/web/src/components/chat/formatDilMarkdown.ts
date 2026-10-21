/**
 * T3 stores assistant messages as Markdown. Some ChatGPT messages contain rich
 * link markers or presentation-only DIL markup. Convert those outside Markdown
 * code while keeping raw examples unchanged, including during streaming.
 */
const DIL_LINE = /(?:^|\n)[ \t]*<(?:box|row|col|card|button|badge|icon|title|caption)\b/;
const DIL_TAG =
  /^<\/?(?:box|row|col|card|button|badge|icon|text|title|caption|grid|grid-item|divider|spacer|pressable)\b[^>]*\/?>/;
const URL_START = "url";
const URL_SEPARATOR = "";
const URL_END = "";
const DAMAGED_LINK_SUFFIX = /^\*\*\\\]\(https?:\/\/[^\n)]*%EE%88%81[^\n)]*\)/;

function markdownLabel(raw: string): string {
  // Preserve inline code within a link's label; escape Markdown punctuation
  // outside it so a model-provided label cannot create a second destination.
  const unescaped = raw.trim().replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1");
  let output = "";
  let cursor = 0;
  while (cursor < unescaped.length) {
    if (unescaped[cursor] === "`") {
      let end = cursor;
      while (unescaped[end] === "`") end++;
      const marker = unescaped.slice(cursor, end);
      const closing = unescaped.indexOf(marker, end);
      if (closing >= 0 && unescaped[closing + marker.length] !== "`") {
        output += unescaped.slice(cursor, closing + marker.length);
        cursor = closing + marker.length;
        continue;
      }
    }
    output += unescaped[cursor]!.replace(/([\\`*_{}[\]()#+\-.!|])/g, "\\$1");
    cursor++;
  }
  return output || "Open link";
}

function safeLink(label: string, destination: string): string {
  // A leading '[' appears in some older malformed ChatGPT transport text.
  // Otherwise preserve every URL character, including a trailing ']'.
  const raw = destination.trim().replace(/^\[(?=https?:\/\/)/i, "");
  try {
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return label;
    }
    return "[" + label + "](<" + url.href + ">)";
  } catch {
    return label;
  }
}

function isEscapedTick(text: string, position: number): boolean {
  let slashCount = 0;
  while (position > 0 && text[--position] === "\\") slashCount++;
  return slashCount % 2 === 1;
}

function closingInlineCode(text: string, start: number, ticks: number): number {
  let candidate = start;
  while ((candidate = text.indexOf("`", candidate)) >= 0) {
    let end = candidate + 1;
    while (text[end] === "`") end++;
    // Backslashes within a code span are literal, not closing-delimiter escapes.
    if (end - candidate === ticks) return end;
    candidate = end;
  }
  return -1;
}

function formatOutsideFence(text: string): string {
  const hasDil = DIL_LINE.test(text);
  let result = "";
  let cursor = 0;
  while (cursor < text.length) {
    if (text.startsWith(URL_START, cursor)) {
      // Bound each attempt by the next marker. An incomplete token cannot
      // consume a later complete link or rescan every remaining prefix.
      const next = text.indexOf(URL_START, cursor + URL_START.length);
      const limit = next < 0 ? text.length : next;
      // Search only this bounded token; an incomplete reference must not scan
      // through every subsequent reference in the message.
      const segment = text.slice(cursor, limit);
      const split = segment.indexOf(URL_SEPARATOR, URL_START.length);
      const end = split < 0 ? -1 : segment.indexOf(URL_END, split + URL_SEPARATOR.length);
      const extra = split < 0 ? -1 : segment.indexOf(URL_SEPARATOR, split + URL_SEPARATOR.length);
      if (end < 0 || (extra >= 0 && extra < end)) {
        result += segment;
        cursor = limit;
        continue;
      }
      const label = markdownLabel(segment.slice(URL_START.length, split));
      const destination = segment.slice(split + URL_SEPARATOR.length, end);
      result += safeLink(label, destination);
      cursor += end + URL_END.length;
      // Historical malformed fallbacks duplicated the reference into a
      // broken Markdown destination. Retain only the bold closing delimiter.
      const suffix = DAMAGED_LINK_SUFFIX.exec(text.slice(cursor, cursor + 4096));
      if (suffix) {
        result += "**";
        cursor += suffix[0].length;
      }
      continue;
    }
    if (text[cursor] === "`" && !isEscapedTick(text, cursor)) {
      const start = cursor;
      while (text[cursor] === "`") cursor++;
      const end = closingInlineCode(text, cursor, cursor - start);
      if (end >= 0) {
        result += text.slice(start, end);
        cursor = end;
      } else {
        // An unmatched delimiter outside a real fence is literal Markdown;
        // it must not swallow subsequent valid URL references.
        result += text.slice(start, cursor);
      }
      continue;
    }
    if (hasDil && text[cursor] === "<") {
      if (/^<button(?=[\s/>])/.test(text.slice(cursor, cursor + 8))) {
        const close = text.indexOf("</button>", cursor);
        if (close >= 0) {
          const button = text.slice(cursor, close + "</button>".length);
          const url = button.match(/GenUI\.openUrl\(\s*["'](https?:\/\/[^"']+)["']\s*\)/)?.[1];
          const openEnd =
            button.indexOf("}>") >= 0 ? button.indexOf("}>") + 2 : button.indexOf(">") + 1;
          const label = button
            .slice(openEnd, button.length - "</button>".length)
            .replace(/<[^>]+>/g, "")
            .trim();
          result += url ? "[" + (label || "Open link") + "](" + url + ")" : label;
          cursor = close + "</button>".length;
          continue;
        }
      }
      const dil = DIL_TAG.exec(text.slice(cursor, cursor + 4096));
      if (dil) {
        cursor += dil[0].length;
        continue;
      }
    }
    result += text[cursor++];
  }
  return hasDil ? result.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n") : result;
}

type MarkdownFence = { marker: "`" | "~"; length: number; quoteDepth: number };

function fenceStart(line: string): MarkdownFence | null {
  // Protect fences nested in Markdown blockquotes, list items, and indented
  // list continuations, not just column-zero code fences.
  const match = /^((?: {0,3}>[ \t]?)* *(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)? *)(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  const marker = match[2]![0] as "`" | "~";
  // Backtick fences cannot have backticks in their info string.
  if (marker === "`" && line.slice(match[0].length).includes("`")) return null;
  return { marker, length: match[2]!.length, quoteDepth: match[1]!.split(">").length - 1 };
}

function closesFence(line: string, fence: MarkdownFence): boolean {
  const match = /^((?: {0,3}>[ \t]?)* *)(`+|~+)[ \t]*\r?$/.exec(line);
  return (
    !!match &&
    match[1]!.split(">").length - 1 === fence.quoteDepth &&
    match[2]![0] === fence.marker &&
    match[2]!.length >= fence.length
  );
}

export function formatDilMarkdown(text: string): string {
  if (!DIL_LINE.test(text) && !text.includes(URL_START)) return text;
  let result = "";
  let plainStart = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const lineEnd = text.indexOf("\n", cursor);
    const end = lineEnd < 0 ? text.length : lineEnd + 1;
    const line = text.slice(cursor, lineEnd < 0 ? end : lineEnd);
    const opening = fenceStart(line);
    if (!opening) {
      cursor = end;
      continue;
    }
    result += formatOutsideFence(text.slice(plainStart, cursor));
    const fenceStartAt = cursor;
    cursor = end;
    while (cursor < text.length) {
      const closeEnd = text.indexOf("\n", cursor);
      const nextEnd = closeEnd < 0 ? text.length : closeEnd + 1;
      const closeLine = text.slice(cursor, closeEnd < 0 ? nextEnd : closeEnd);
      cursor = nextEnd;
      if (closesFence(closeLine, opening)) break;
    }
    result += text.slice(fenceStartAt, cursor);
    plainStart = cursor;
  }
  return result + formatOutsideFence(text.slice(plainStart));
}
