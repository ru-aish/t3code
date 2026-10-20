import { assert, it } from "@effect/vitest";
import { MessageId, RunId, type OrchestrationV2ConversationMessage } from "@t3tools/contracts";

import { mailboxMessageAtSend } from "./NotificationMailbox.ts";

const original = {
  id: MessageId.make("message:mailbox-at-send"),
  text: "Delegated task A reached a terminal state.",
  delegatedCompletion: {
    parentRunId: RunId.make("run:mailbox-parent"),
    generation: 1,
    taskIds: [],
  },
} as unknown as OrchestrationV2ConversationMessage;

it("includes persisted sibling updates in the last send-time mailbox snapshot", () => {
  const latest = {
    ...original,
    text: "Delegated tasks A, B reached terminal states.",
  };
  assert.deepEqual(mailboxMessageAtSend(original, latest), latest);
});

it("does not adopt another mailbox generation or replace ordinary user input", () => {
  const newerGeneration = {
    ...original,
    text: "Unrelated delivery",
    delegatedCompletion: { ...original.delegatedCompletion!, generation: 2 },
  };
  assert.deepEqual(mailboxMessageAtSend(original, newerGeneration), original);
  assert.deepEqual(
    mailboxMessageAtSend({ ...original, delegatedCompletion: undefined }, newerGeneration),
    { ...original, delegatedCompletion: undefined },
  );
});
