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

function formatOutsideFence(text: string): string {
  const hasDil = DIL_LINE.test(text);
  // Match each backtick run in linear time, including unmatched delimiters.
  // A backslash inside an open code span does not escape its closing run.
  const nextCloser = new Map<number, number>();
  const nextEndForLength = new Map<number, number>();
  const runs = Array.from(text.matchAll(/`+/g));
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!;
    const length = run[0].length;
    nextCloser.set(run.index, nextEndForLength.get(length) ?? -1);
    nextEndForLength.set(length, run.index + length);
  }
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
      const end = nextCloser.get(start) ?? -1;
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

type MarkdownFence = {
  marker: "`" | "~";
  length: number;
  quoteDepth: number;
  listIndent: number;
};

// Markdown's container and indentation boundaries must be tracked before
// interpreting embedded links or SVGs as presentation markup. Keep this
// self-contained: the ChatGPT protocol function is serialized into the browser.
function markdownCodeRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let fence: MarkdownFence | null = null;
  let start = -1;
  let indented = false;
  let paragraph = false;
  let previousQuoteDepth = 0;
  let listIndent = 0;
  let cursor = 0;
  function columns(value: string): number {
    let col = 0;
    for (const char of value) {
      if (char === " ") col++;
      else if (char === "\t") col += 4 - (col % 4);
      else break;
    }
    return col;
  }
  function quotesFrom(line: string, maxDepth = Infinity): { count: number; rest: string } {
    let count = 0;
    let rest = line;
    while (count < maxDepth) {
      const match = /^ {0,3}>[ \t]?/.exec(rest);
      if (!match) break;
      rest = rest.slice(match[0].length);
      count++;
    }
    return { count, rest };
  }
  while (cursor < text.length) {
    const lineEnd = text.indexOf("\n", cursor);
    const end = lineEnd < 0 ? text.length : lineEnd + 1;
    const line = text.slice(cursor, lineEnd < 0 ? end : lineEnd);
    if (fence) {
      // A top-level fence owns every character of its body, including leading
      // ">" characters that would otherwise be blockquote delimiters.
      const { count, rest } = fence.quoteDepth
        ? quotesFrom(line, fence.quoteDepth)
        : { count: 0, rest: line };
      const blank = rest.trim() === "";
      const indent = columns(rest);
      if (count !== fence.quoteDepth || (!blank && indent < fence.listIndent)) {
        ranges.push({ start, end: cursor });
        start = -1;
        fence = null;
        paragraph = false;
        // The current line is outside the just-ended container.
        continue;
      }
      const candidate = /^([ \t]*)(`{3,}|~{3,})[ \t]*\r?$/.exec(rest);
      if (
        candidate &&
        indent >= fence.listIndent &&
        indent - fence.listIndent <= 3 &&
        candidate[2]![0] === fence.marker &&
        candidate[2]!.length >= fence.length
      ) {
        ranges.push({ start, end });
        fence = null;
        start = -1;
        paragraph = false;
      }
      cursor = end;
      continue;
    }
    const { count, rest } = quotesFrom(line);
    const blank = rest.trim() === "";
    // Omitted '>' markers can lazily continue an existing quoted paragraph.
    // Retain the logical quote depth across those lines so a later explicit
    // '>' prefix resumes the same paragraph instead of starting indented code.
    const interruptsQuotedParagraph =
      /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-+*]|\d{1,9}[.)])[ \t]+|(?:`{3,}|~{3,})|(?:={3,})[ \t]*$)/.test(
        rest,
      ) ||
      (columns(rest) <= 3 &&
        /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(rest.trimStart()));
    const lazyQuotedParagraph =
      count < previousQuoteDepth && paragraph && !blank && !interruptsQuotedParagraph;
    if (count !== previousQuoteDepth && !lazyQuotedParagraph) {
      paragraph = false;
      listIndent = 0;
      previousQuoteDepth = count;
    }
    const indent = columns(rest);
    // CommonMark resolves thematic breaks before list starts. Otherwise
    // "- - -" and "* * *" become list items and leak list indentation.
    const thematicBreak =
      indent <= 3 &&
      /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(rest.trimStart());
    const list = thematicBreak ? null : /^ {0,3}(?:[-+*]|\d{1,9}[.)])([ \t]+)/.exec(rest);
    if (indented) {
      if (blank || indent >= listIndent + 4) {
        cursor = end;
        continue;
      }
      ranges.push({ start, end: cursor });
      indented = false;
      start = -1;
      paragraph = false;
      continue;
    }
    if (list) {
      listIndent = 0;
      for (const char of list[0]) {
        listIndent += char === "\t" ? 4 - (listIndent % 4) : 1;
      }
      paragraph = false;
    } else if (!blank && listIndent && indent < listIndent) {
      listIndent = 0;
      paragraph = false;
    }
    // A fence on a list continuation uses the list content column rather
    // than a new zero-indent container. Tabs advance to four-column stops.
    const relative = list ? 0 : indent - listIndent;
    const content = list ? rest.slice(list[0].length) : rest.trimStart();
    const opening = relative >= 0 && relative <= 3 ? /^(`{3,}|~{3,})(.*)$/.exec(content) : null;
    if (opening && (opening[1]![0] === "~" || !opening[2]!.includes("`"))) {
      fence = {
        marker: opening[1]![0] as "`" | "~",
        length: opening[1]!.length,
        quoteDepth: count,
        listIndent,
      };
      start = cursor;
      paragraph = false;
      cursor = end;
      continue;
    }
    // Indented code cannot interrupt an existing paragraph. A four-space
    // continuation after ordinary prose is still prose per CommonMark.
    if (!blank && !paragraph && !list && relative >= 4) {
      start = cursor;
      indented = true;
      cursor = end;
      continue;
    }
    // Headings and thematic breaks close a block; the next indented line
    // can begin a code block. Only ordinary prose continues a paragraph.
    const atxHeading =
      !list && relative >= 0 && relative <= 3 && /^#{1,6}(?:[ \t]|$)/.test(content);
    const setextHeading: boolean =
      !list && paragraph && relative >= 0 && relative <= 3 && /^(?:=+|-+)[ \t]*$/.test(content);
    paragraph = !blank && !atxHeading && !thematicBreak && !setextHeading;
    cursor = end;
  }
  if (start >= 0) ranges.push({ start, end: text.length });
  return ranges;
}

export function formatDilMarkdown(text: string): string {
  if (!DIL_LINE.test(text) && !text.includes(URL_START)) return text;
  let result = "";
  let plainStart = 0;
  for (const range of markdownCodeRanges(text)) {
    result += formatOutsideFence(text.slice(plainStart, range.start));
    result += text.slice(range.start, range.end);
    plainStart = range.end;
  }
  return result + formatOutsideFence(text.slice(plainStart));
}
