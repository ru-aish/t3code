import { describe, expect, it } from "vite-plus/test";

import {
  chatGPTActivityMatchesUser,
  chatGPTBindingWorkspaceEnvelopeSentAt,
  shouldFinalizeChatGPTAssistantMessage,
  shouldUpdateChatGPTConversationBinding,
} from "./ChatGPTAgentReactor.ts";

describe("ChatGPTAgentReactor assistant settlement", () => {
  it("matches resumed Desktop activity to the exact T3 user message or its workspace envelope", () => {
    expect(chatGPTActivityMatchesUser("inspect the repo", "inspect the repo")).toBe(true);
    expect(
      chatGPTActivityMatchesUser(
        "Workspace: /tmp/repo. This folder is the working space.\n\ninspect the repo",
        "inspect the repo",
      ),
    ).toBe(true);
    expect(chatGPTActivityMatchesUser("continue", "inspect the repo")).toBe(false);
  });

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

  it("replaces a stale conversation binding only when a new stable id is available", () => {
    expect(shouldUpdateChatGPTConversationBinding("old-id", "new-id")).toBe(true);
    expect(shouldUpdateChatGPTConversationBinding("same-id", "same-id")).toBe(false);
    expect(shouldUpdateChatGPTConversationBinding("old-id", undefined)).toBe(false);
  });

  it("requires a successful replacement turn before marking its workspace envelope sent", () => {
    const previousSentAt = "2026-07-13T00:00:00.000Z";
    const updatedAt = "2026-07-14T00:00:00.000Z";
    expect(
      chatGPTBindingWorkspaceEnvelopeSentAt({
        initialSend: false,
        conversationReplaced: true,
        existingWorkspaceEnvelopeSentAt: previousSentAt,
        updatedAt,
      }),
    ).toBeNull();
    expect(
      chatGPTBindingWorkspaceEnvelopeSentAt({
        initialSend: false,
        conversationReplaced: false,
        existingWorkspaceEnvelopeSentAt: previousSentAt,
        updatedAt,
      }),
    ).toBe(previousSentAt);
    expect(
      chatGPTBindingWorkspaceEnvelopeSentAt({
        initialSend: true,
        conversationReplaced: false,
        existingWorkspaceEnvelopeSentAt: undefined,
        updatedAt,
      }),
    ).toBeNull();
  });
});
