import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ChatGPTBackendServiceId = Schema.Literals([
  "chatgpt-desktop",
  "terminal-mcp-t3",
  "terminal-cloudflared-t3",
]);
export type ChatGPTBackendServiceId = typeof ChatGPTBackendServiceId.Type;

export const ChatGPTBackendAction = Schema.Literals(["start", "stop", "restart", "ensure"]);
export type ChatGPTBackendAction = typeof ChatGPTBackendAction.Type;

export const ChatGPTBackendServiceState = Schema.Literals([
  "running",
  "starting",
  "stopped",
  "failed",
  "unavailable",
]);
export type ChatGPTBackendServiceState = typeof ChatGPTBackendServiceState.Type;

export const ChatGPTBackendOverallStatus = Schema.Literals([
  "ready",
  "degraded",
  "stopped",
  "unavailable",
]);
export type ChatGPTBackendOverallStatus = typeof ChatGPTBackendOverallStatus.Type;

export const ChatGPTBackendServiceStatus = Schema.Struct({
  id: ChatGPTBackendServiceId,
  label: TrimmedNonEmptyString,
  description: Schema.String,
  unitName: TrimmedNonEmptyString,
  state: ChatGPTBackendServiceState,
  activeState: Schema.NullOr(Schema.String),
  subState: Schema.NullOr(Schema.String),
  endpoint: Schema.NullOr(Schema.String),
  healthy: Schema.NullOr(Schema.Boolean),
  detail: Schema.NullOr(Schema.String),
  canControl: Schema.Boolean,
});
export type ChatGPTBackendServiceStatus = typeof ChatGPTBackendServiceStatus.Type;

export const ChatGPTBackendStatus = Schema.Struct({
  checkedAt: Schema.String,
  platform: Schema.String,
  systemdAvailable: Schema.Boolean,
  autoStartEnabled: Schema.Boolean,
  overallStatus: ChatGPTBackendOverallStatus,
  cdpEndpoint: Schema.String,
  terminalEndpoint: Schema.String,
  services: Schema.Array(ChatGPTBackendServiceStatus),
  error: Schema.NullOr(Schema.String),
});
export type ChatGPTBackendStatus = typeof ChatGPTBackendStatus.Type;

export const ChatGPTBackendControlInput = Schema.Struct({
  action: ChatGPTBackendAction,
  serviceId: Schema.optional(ChatGPTBackendServiceId),
});
export type ChatGPTBackendControlInput = typeof ChatGPTBackendControlInput.Type;

export class ChatGPTBackendControlError extends Schema.TaggedError<ChatGPTBackendControlError>()(
  "ChatGPTBackendControlError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}
