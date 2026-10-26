import {
  NodeId,
  TurnItemId,
  type RuntimeRequestId,
  type ThreadId,
  type RunId,
  type ProviderThreadId,
  type ProviderTurnId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

export function messageQuestionArtifacts(input: {
  threadId: ThreadId;
  runId: RunId;
  rootNodeId: NodeId;
  providerThreadId: ProviderThreadId | null;
  providerTurnId: ProviderTurnId | null;
  requestId: RuntimeRequestId;
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  ordinal: number;
  now: DateTime.Utc;
}) {
  const nodeId = NodeId.make(`node:question:${input.requestId}`);
  const node: OrchestrationV2ExecutionNode = {
    id: nodeId,
    threadId: input.threadId,
    runId: input.runId,
    parentNodeId: input.rootNodeId,
    rootNodeId: input.rootNodeId,
    kind: "user_input_request",
    status: "waiting",
    countsForRun: false,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    runtimeRequestId: input.requestId,
    checkpointScopeId: null,
    startedAt: input.now,
    completedAt: null,
  };
  const request: OrchestrationV2RuntimeRequest = {
    id: input.requestId,
    nodeId,
    providerTurnId: input.providerTurnId,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: input.now,
    resolvedAt: null,
  };
  const turnItem: OrchestrationV2TurnItem = {
    id: TurnItemId.make(`turn-item:question:${input.requestId}`),
    threadId: input.threadId,
    runId: input.runId,
    nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "waiting",
    title: null,
    startedAt: input.now,
    completedAt: null,
    updatedAt: input.now,
    type: "user_input_request",
    requestId: input.requestId,
    questions: input.questions.map((question) => ({
      ...question,
      ...(question.options.length === 0 ? { allowCustomAnswer: true } : {}),
    })),
    responseMode: "message",
  };
  return { node, request, turnItem };
}
