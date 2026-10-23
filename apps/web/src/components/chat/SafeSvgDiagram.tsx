import DOMPurify from "dompurify";
import { useMemo } from "react";

const MAX_SVG_LENGTH = 100_000;
const MAX_SVG_ELEMENTS = 1_000;
const REMOTE_URL = /url\(\s*(?!['"]?#)[^)]*\)/i;

let purifier: ReturnType<typeof DOMPurify> | null = null;

/** Render SVG from agent output as inert artwork, never as executable markup. */
export function sanitizeAgentSvg(source: string): string | null {
  if (source.length > MAX_SVG_LENGTH || typeof DOMParser === "undefined") return null;
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (
    root.localName !== "svg" ||
    (root.namespaceURI !== null && root.namespaceURI !== "http://www.w3.org/2000/svg") ||
    parsed.querySelector("parsererror") ||
    parsed.querySelectorAll("*").length > MAX_SVG_ELEMENTS
  ) {
    return null;
  }

  if (!purifier) {
    purifier = DOMPurify(window);
    purifier.addHook("uponSanitizeAttribute", (_node, data) => {
      if (REMOTE_URL.test(data.attrValue)) data.keepAttr = false;
    });
  }
  const svg = purifier.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      "script",
      "style",
      "foreignObject",
      "image",
      "feImage",
      "a",
      "animate",
      "animateMotion",
      "animateTransform",
      "set",
    ],
    FORBID_ATTR: ["class", "href", "xlink:href", "src", "srcset", "style"],
  });
  return /^<svg(?:\s|>)/i.test(svg) ? svg : null;
}

export function SafeSvgDiagram({ source }: { source: string }) {
  const svg = useMemo(() => sanitizeAgentSvg(source), [source]);
  if (!svg) {
    return (
      <p className="text-xs text-muted-foreground">
        SVG preview unavailable. View the source instead.
      </p>
    );
  }
  return (
    <div
      role="img"
      aria-label="SVG illustration"
      className="flex max-h-[32rem] min-h-24 items-center justify-center overflow-auto scrollbar-gutter-both rounded-md bg-background p-3 [&>svg]:h-auto [&>svg]:max-h-[30rem] [&>svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
