import {
  latestProviderTurnForAttempt,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

/**
 * Read the durable mailbox payload at the last possible provider send boundary.
 * Generation and parent identity prevent a stale preparation from adopting
 * another delivery's message; ordinary user turns are never rewritten.
 */
export function mailboxMessageAtSend(
  initial: OrchestrationV2ConversationMessage,
  latest: OrchestrationV2ConversationMessage | undefined,
): OrchestrationV2ConversationMessage {
  const ownership = initial.delegatedCompletion;
  return ownership !== undefined &&
    latest?.id === initial.id &&
    latest.delegatedCompletion?.parentRunId === ownership.parentRunId &&
    latest.delegatedCompletion?.generation === ownership.generation
    ? latest
    : initial;
}

export function isBufferedProviderNotification(
  message: OrchestrationV2ConversationMessage,
): boolean {
  return (
    message.createdBy === "agent" &&
    message.creationSource === "provider" &&
    message.notification !== undefined &&
    message.delegatedCompletion === undefined
  );
}

/**
 * Delivery is at least once: provider acceptance and our receipt cannot commit
 * atomically. Reusing the message ID keeps recovery from duplicating timeline items.
 */
export function isUndeliveredMailboxSteer(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs" | "providerTurns">,
  messageId: MessageId,
): boolean {
  const message = projection.messages.find((candidate) => candidate.id === messageId);
  if (message?.delegatedCompletion === undefined) return false;
  const run = projection.runs.find((candidate) => candidate.id === message.runId);
  return (
    run !== undefined &&
    run.userMessageId !== message.id &&
    (["completed", "forced", "failed", "interrupted", "cancelled", "rolled_back"].includes(
      run.status,
    ) ||
      latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId)?.status ===
        "completed")
  );
}
