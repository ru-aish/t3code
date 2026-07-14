import { describe, expect, it } from "vite-plus/test";

import { applyMessageTextUpdate } from "./messageText.ts";

describe("applyMessageTextUpdate", () => {
  it("appends ordinary streaming deltas", () => {
    expect(
      applyMessageTextUpdate({
        previous: "Hello",
        text: " world",
        streaming: true,
      }),
    ).toBe("Hello world");
  });

  it("replaces a provisional assistant preamble with the rewritten Desktop snapshot", () => {
    expect(
      applyMessageTextUpdate({
        previous: "I’ll inspect the repository layout.",
        text: "The repository is a TypeScript monorepo.",
        streaming: true,
        replace: true,
      }),
    ).toBe("The repository is a TypeScript monorepo.");
  });

  it("keeps the accumulated text when completion carries an empty payload", () => {
    expect(
      applyMessageTextUpdate({
        previous: "Final answer",
        text: "",
        streaming: false,
      }),
    ).toBe("Final answer");
  });
});
