/**
 * T3 stores historical assistant text as Markdown. Older ChatGPT sessions can
 * contain raw DIL markup or ChatGPT link references instead; degrade these to
 * readable Markdown without changing code spans or ordinary HTML.
 */
const DIL_LINE = /(?:^|\n)[ \t]*<(?:box|row|col|card|button|badge|icon|title|caption)\b/;
const DIL_TAG = /<\/?(?:box|row|col|card|button|badge|icon|text|title|caption|grid|grid-item|divider|spacer|pressable)\b[^>]*\/?>/g;
const CHATGPT_URL = /url([^\n]*)([^\n]*)(\*\*\\\]\(https?:\/\/[^)\n]*%EE%88%81[^)\n]*\))?/g;

function formatChatGPTUrls(text: string): string {
  if (!text.includes("url")) return text;
  return text.replace(CHATGPT_URL, (_match, rawLabel: string, rawDestination: string, damagedSuffix?: string) => {
    const label = rawLabel.trim().replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1");
    const escapedLabel = label.replace(/([\\`*_{}[\]()#+\-.!|])/g, "\\$1") || "Open link";
    // Historical fallbacks sometimes accidentally include the opening '[' of a
    // Markdown destination in a ChatGPT reference.
    const destination = rawDestination.trim().replace(/^\[/, "").replace(/\]$/, "");
    try {
      const url = new URL(destination);
      if (url.protocol !== "https:" && url.protocol !== "http:") return escapedLabel;
      if (!url.hostname || url.username || url.password) return escapedLabel;
      // Angle-delimited destinations preserve parentheses and other URL punctuation.
      const link = `[${escapedLabel}](<${url.href}>)`;
      // An older malformed conversion duplicated the URL after a literal
      // "**\\](...%EE%88%81...)". Preserve the closing bold delimiter only.
      return damagedSuffix ? link + "**" : link;
    } catch {
      return escapedLabel;
    }
  });
}

function formatOutsideCode(text: string): string {
  const withLinks = formatChatGPTUrls(text);
  if (!DIL_LINE.test(withLinks)) return withLinks;
  return withLinks
    .replace(/<button\b[\s\S]*?<\/button>/g, (button) => {
      const url = button.match(/GenUI\.openUrl\(\s*["'](https?:\/\/[^"']+)["']\s*\)/)?.[1];
      const openEnd = button.indexOf("}>") >= 0 ? button.indexOf("}>") + 2 : button.indexOf(">") + 1;
      const label = button.slice(openEnd, button.lastIndexOf("</button>"))
        .replace(/<[^>]+>/g, "").trim();
      return url ? "[" + (label || "Open link") + "](" + url + ")" : label;
    })
    .replace(DIL_TAG, "")
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n");
}

export function formatDilMarkdown(text: string): string {
  if (!DIL_LINE.test(text) && !text.includes("url")) return text;
  // Leave code and examples unchanged, including inline code and unclosed fences
  // received mid-stream. Only transform text outside matching backtick runs.
  let result = "";
  let plainStart = 0;
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== "`") {
      cursor++;
      continue;
    }
    const openStart = cursor;
    while (text[cursor] === "`") cursor++;
    const ticks = cursor - openStart;
    let closing = cursor;
    while ((closing = text.indexOf("`", closing)) >= 0) {
      let closeEnd = closing;
      while (text[closeEnd] === "`") closeEnd++;
      if (closeEnd - closing === ticks) break;
      closing = closeEnd;
    }
    if (closing < 0 && ticks < 3) continue;
    result += formatOutsideCode(text.slice(plainStart, openStart));
    if (closing < 0) return result + text.slice(openStart);
    cursor = closing + ticks;
    result += text.slice(openStart, cursor);
    plainStart = cursor;
  }
  return result + formatOutsideCode(text.slice(plainStart));
}
