import { describe, expect, it } from "vite-plus/test";

import { shouldFinalizeChatGPTAssistantMessage } from "./ChatGPTAgentReactor.ts";

describe("ChatGPTAgentReactor assistant settlement", () => {
  it("preserves successful-turn completion even before a visible delta", () => {
    expect(
      shouldFinalizeChatGPTAssistantMessage({
        assistantMessageStarted: false,
        outcome: "succeeded",
      }),
    ).toBe(true);
  });

  it.each(["interrupted", "failed"] as const)(
    "finalizes a partial assistant message when the stream is %s",
    (outcome) => {
      expect(
        shouldFinalizeChatGPTAssistantMessage({
          assistantMessageStarted: true,
          outcome,
        }),
      ).toBe(true);
    },
  );

  it.each(["interrupted", "failed"] as const)(
    "does not create an empty assistant message when the stream is %s before any delta",
    (outcome) => {
      expect(
        shouldFinalizeChatGPTAssistantMessage({
          assistantMessageStarted: false,
          outcome,
        }),
      ).toBe(false);
    },
  );
});
