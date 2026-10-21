import type { ChatGPTUpdate } from "./connection.ts";

// Runs inside the authenticated renderer as well as in focused protocol tests.
// Keep self-contained so its serialized function needs no module globals.
export function normalizeStreamMessage(
  raw: unknown,
): Omit<ChatGPTUpdate, "kind" | "conversationId"> {
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
        /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-+*]|\d{1,9}[.)])[ \t]+|(?:`{3,}|~{3,}))/.test(rest) ||
        (columns(rest) <= 3 &&
          /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(rest.trimStart()));
      const lazyQuotedParagraph: boolean =
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
        !list &&
        paragraph &&
        !lazyQuotedParagraph &&
        relative >= 0 &&
        relative <= 3 &&
        /^(?:=+|-+)[ \t]*$/.test(content);
      paragraph = !blank && !atxHeading && !thematicBreak && !setextHeading;
      cursor = end;
    }
    if (start >= 0) ranges.push({ start, end: text.length });
    return ranges;
  }

  type Span = { start: number; end: number };

  function inRanges(ranges: Span[], position: number): boolean {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (ranges[mid]!.end <= position) low = mid + 1;
      else high = mid;
    }
    return low < ranges.length && ranges[low]!.start <= position;
  }

  function intersectsRanges(ranges: Span[], start: number, end: number): boolean {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (ranges[mid]!.end <= start) low = mid + 1;
      else high = mid;
    }
    return low < ranges.length && ranges[low]!.start < end;
  }

  function mergeRanges(ranges: Span[]): Span[] {
    const merged: Span[] = [];
    for (const span of ranges.toSorted((a, b) => a.start - b.start)) {
      const last = merged[merged.length - 1];
      if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
      else merged.push({ ...span });
    }
    return merged;
  }

  function markdownLiteralRanges(text: string): Span[] {
    const blocks = markdownCodeRanges(text);
    const ticks: RegExpExecArray[] = [];
    const tickPattern = /`+/g;
    let tick: RegExpExecArray | null;
    while ((tick = tickPattern.exec(text))) {
      ticks.push(tick);
      // A pathological answer is safer without chart extraction/anchoring.
      if (ticks.length > 1_000) return [{ start: 0, end: text.length }];
    }
    const nextCloser = new Map<number, number>();
    const nextEnd = new Map<number, number>();
    for (let index = ticks.length - 1; index >= 0; index--) {
      const run = ticks[index]!;
      nextCloser.set(run.index, nextEnd.get(run[0].length) ?? -1);
      nextEnd.set(run[0].length, run.index + run[0].length);
    }
    const inline: Span[] = [];
    let until = -1;
    for (const run of ticks) {
      if (run.index < until || inRanges(blocks, run.index)) continue;
      let slashes = 0;
      for (let i = run.index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
      if (slashes % 2) continue;
      const closing = nextCloser.get(run.index) ?? -1;
      if (closing > run.index && !intersectsRanges(blocks, run.index, closing)) {
        inline.push({ start: run.index, end: closing });
        until = closing;
      }
    }
    return mergeRanges([...blocks, ...inline]);
  }

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
  // DIL chart payloads are omitted from ChatGPT's Markdown fallback. Preserve
  // validated JSON snapshots without interpreting any executable DIL syntax.
  function chartSnapshots(source: string): Array<{ json: string; start: number; end: number }> {
    if (!source.includes("<Chart") || source.length > 500_000) return [];
    // Collect protected ranges in source order. Raw blocks and comments are
    // skipped as complete units; membership checks use a sorted code-span index.
    const literalRanges = markdownLiteralRanges(source);
    const rawRanges: Span[] = [];
    const rawOpening = /<!--|<Chart(?=[\s/>])|<(CodeBlock|WritingBlock|AppBlock|escape)\b[^>]*>/g;
    function chartTagEnd(offset: number): number {
      const opening = /^<Chart\s+content=\{/.exec(source.slice(offset, offset + 64));
      if (!opening) return -1;
      let depth = 1;
      let quote: string | null = null;
      let escaped = false;
      const start = offset + opening[0].length;
      for (let i = start; i < source.length && i - start <= 30_000; i++) {
        const ch = source[i]!;
        if (quote) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === "{") {
          depth++;
        } else if (ch === "}" && --depth === 0) {
          const closing = /^\s*\/>/.exec(source.slice(i + 1, i + 16));
          return closing ? i + 1 + closing[0].length : -1;
        }
      }
      return -1;
    }
    let raw: RegExpExecArray | null;
    while ((raw = rawOpening.exec(source))) {
      if (inRanges(literalRanges, raw.index)) continue;
      if (raw[0] === "<Chart") {
        // Comment-like strings in a complete chart's JSON are data, not markup.
        const end = chartTagEnd(raw.index);
        if (end > 0) rawOpening.lastIndex = end;
        continue;
      }
      let end: number;
      if (raw[0] === "<!--") {
        const closeAt = source.indexOf("-->", rawOpening.lastIndex);
        end = closeAt < 0 ? source.length : closeAt + 3;
      } else {
        const closing = `</${raw[1]}>`;
        const closeAt = source.indexOf(closing, rawOpening.lastIndex);
        end = closeAt < 0 ? source.length : closeAt + closing.length;
      }
      rawRanges.push({ start: raw.index, end });
      rawOpening.lastIndex = end;
    }
    const protectedRanges = mergeRanges([...literalRanges, ...rawRanges]);
    const charts: Array<{ json: string; start: number; end: number }> = [];
    const marker = /<Chart(?=[\s/>])/g;
    let match: RegExpExecArray | null;
    while ((match = marker.exec(source)) && charts.length < 8) {
      const offset = match.index;
      if (inRanges(protectedRanges, offset)) continue;
      let slashes = 0;
      for (let i = offset - 1; i >= 0 && source[i] === "\\"; i--) slashes++;
      if (slashes % 2) continue;
      const attribute = /^<Chart\s+content=\{/.exec(source.slice(offset, offset + 64));
      if (!attribute) continue;
      const start = offset + attribute[0].length;
      let depth = 1;
      let quote: string | null = null;
      let escaped = false;
      let end = start;
      for (; end < source.length && end - start <= 30_000; end++) {
        const ch = source[end]!;
        if (quote) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) break;
      }
      if (depth !== 0 || !/^\s*\/>/.test(source.slice(end + 1, end + 16))) continue;
      try {
        const value: unknown = JSON.parse(source.slice(start, end));
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const chart = value as Record<string, unknown>;
        if (
          !["bar", "line", "scatter", "pie"].includes(String(chart.chartType)) ||
          !Array.isArray(chart.data) ||
          chart.data.length > 200 ||
          !Array.isArray(chart.series) ||
          chart.series.length > 6
        )
          continue;
        const json = JSON.stringify(chart);
        if (json.length > 30_000) continue;
        const closingEnd = end + 1 + /^\s*\/>/.exec(source.slice(end + 1, end + 16))![0].length;
        charts.push({ json, start: offset, end: closingEnd });
        marker.lastIndex = closingEnd;
      } catch {
        // Dynamic expressions and partially streamed charts are not executable.
      }
    }
    return charts;
  }
  const charts = isFinal ? chartSnapshots(originalText) : [];
  // T3 renders Markdown, not ChatGPT's DIL components. Prefer the supplied
  // Markdown fallback even when content.parts contains rich UI source.
  let displayText = (isFinal && fallback?.trim()) || originalText || fallback || "";
  const chartFence = (json: string) => `\n\n\`\`\`t3-chart\n${json}\n\`\`\`\n\n`;
  if (charts.length > 0 && !(isFinal && fallback?.trim())) {
    // Replace at the original offsets before degrading surrounding DIL markup.
    for (const chart of charts.toReversed()) {
      displayText =
        displayText.slice(0, chart.start) + chartFence(chart.json) + displayText.slice(chart.end);
    }
  } else if (charts.length > 0) {
    // Prefer the official Markdown fallback, anchoring a chart beside matching
    // nearby visible text when the fallback retains it. Do not guess positions
    // when the fallback has substantially rewritten its prose.
    let searchFrom = 0;
    for (const chart of charts) {
      const before = originalText
        .slice(Math.max(0, chart.start - 256), chart.start)
        .replace(/<[^>]*>/g, "")
        .trim()
        .slice(-120);
      const protectedFallback = markdownLiteralRanges(displayText);
      let insertAt = -1;
      for (let len = before.length; len >= 12 && insertAt < 0; len--) {
        const anchor = before.slice(-len);
        let hit = displayText.indexOf(anchor, searchFrom);
        while (hit >= 0) {
          if (!intersectsRanges(protectedFallback, hit, hit + anchor.length)) {
            insertAt = hit + anchor.length;
            break;
          }
          hit = displayText.indexOf(anchor, hit + 1);
        }
      }
      if (insertAt < 0) insertAt = displayText.length;
      const fence = chartFence(chart.json);
      displayText = displayText.slice(0, insertAt) + fence + displayText.slice(insertAt);
      searchFrom = insertAt + fence.length;
    }
  }
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
    const protectedRanges = markdownCodeRanges(displayText);
    let protectedIndex = 0;
    // Index equal-length backtick closers once; otherwise unmatched spans can
    // repeatedly scan the entire remainder during incremental streaming.
    const nextCloser = new Map<number, number>();
    const nextEndForLength = new Map<number, number>();
    const ticks = Array.from(displayText.matchAll(/`+/g));
    for (let index = ticks.length - 1; index >= 0; index--) {
      const tick = ticks[index]!;
      const length = tick[0].length;
      nextCloser.set(tick.index, nextEndForLength.get(length) ?? -1);
      nextEndForLength.set(length, tick.index + length);
    }
    let cursor = 0;
    let plainStart = 0;
    while (cursor < displayText.length) {
      const nextTag = displayText.indexOf("<", cursor);
      const nextCode = displayText.indexOf("`", cursor);
      const codeRange = protectedRanges[protectedIndex];
      const nextEvent = Math.min(
        nextTag < 0 ? Infinity : nextTag,
        nextCode < 0 ? Infinity : nextCode,
      );
      if (codeRange && codeRange.start <= nextEvent) {
        if (plainStart < codeRange.start)
          sections.push({ kind: "text", value: displayText.slice(plainStart, codeRange.start) });
        sections.push({ kind: "code", value: displayText.slice(codeRange.start, codeRange.end) });
        cursor = codeRange.end;
        plainStart = cursor;
        protectedIndex++;
        continue;
      }
      if (nextTag < 0 && nextCode < 0) break;
      if (nextCode >= 0 && (nextTag < 0 || nextCode < nextTag)) {
        let runEnd = nextCode + 1;
        while (displayText[runEnd] === "`") runEnd++;
        let codeEnd = -1;
        // A backslash can escape an opening run, but is literal once open.
        let slashes = 0;
        for (let i = nextCode - 1; i >= 0 && displayText[i] === "\\"; i--) slashes++;
        if (slashes % 2 === 0) {
          const candidate = nextCloser.get(nextCode) ?? -1;
          if (candidate <= (codeRange?.start ?? Infinity)) codeEnd = candidate;
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
      // Markdown-escaped <svg> is literal, including any nested SVG children.
      let slashes = 0;
      for (let i = nextTag - 1; i >= 0 && displayText[i] === "\\"; i--) slashes++;
      if (slashes % 2 === 1) {
        cursor = svgEnd;
        continue;
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
