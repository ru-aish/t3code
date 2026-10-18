/**
 * T3 stores historical assistant text as Markdown. Older ChatGPT sessions can
 * contain raw DIL markup instead; degrade unsupported components to readable
 * Markdown without changing code fences or ordinary HTML from other agents.
 */
const DIL_LINE = /(?:^|\n)[ \t]*<(?:box|row|col|card|button|badge|icon|title|caption)\b/;
const DIL_TAG = /<\/?(?:box|row|col|card|button|badge|icon|text|title|caption|grid|grid-item|divider|spacer|pressable)\b[^>]*\/?>/g;

function formatOutsideFence(text: string): string {
  if (!DIL_LINE.test(text)) return text;
  return text
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
  if (!DIL_LINE.test(text)) return text;
  // Markdown examples and code blocks must remain untouched.
  return text.split(/(```[\s\S]*?```)/g).map((part, index) =>
    index % 2 === 1 ? part : formatOutsideFence(part)
  ).join("");
}
