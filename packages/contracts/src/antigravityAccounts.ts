import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const AntigravityAccountId = TrimmedNonEmptyString.pipe(
  Schema.brand("AntigravityAccountId"),
);
export type AntigravityAccountId = typeof AntigravityAccountId.Type;

export const AntigravityAccountRecord = Schema.Struct({
  id: AntigravityAccountId,
  label: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
  email: Schema.optional(TrimmedString),
  createdAt: IsoDateTime,
  lastUsedAt: Schema.optional(IsoDateTime),
});
export type AntigravityAccountRecord = typeof AntigravityAccountRecord.Type;

export const AntigravityAccountsRegistry = Schema.Struct({
  activeAccountId: Schema.optional(AntigravityAccountId),
  dismissedFingerprints: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  accounts: Schema.Array(AntigravityAccountRecord).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type AntigravityAccountsRegistry = typeof AntigravityAccountsRegistry.Type;

export const AntigravityAccountDetection = Schema.Struct({
  fingerprint: TrimmedNonEmptyString,
  authenticated: Schema.Boolean,
  email: Schema.optional(TrimmedString),
  isKnown: Schema.Boolean,
  isDismissed: Schema.Boolean,
  activeAccountId: Schema.optional(AntigravityAccountId),
  matchedAccountId: Schema.optional(AntigravityAccountId),
});
export type AntigravityAccountDetection = typeof AntigravityAccountDetection.Type;

export const AntigravityAccountsListResult = Schema.Struct({
  registry: AntigravityAccountsRegistry,
  detection: AntigravityAccountDetection,
});
export type AntigravityAccountsListResult = typeof AntigravityAccountsListResult.Type;

export const AntigravityAccountSaveInput = Schema.Struct({
  label: Schema.optional(TrimmedString),
});
export type AntigravityAccountSaveInput = typeof AntigravityAccountSaveInput.Type;

export const AntigravityAccountSwitchInput = Schema.Struct({
  accountId: AntigravityAccountId,
});
export type AntigravityAccountSwitchInput = typeof AntigravityAccountSwitchInput.Type;

export const AntigravityAccountRemoveInput = Schema.Struct({
  accountId: AntigravityAccountId,
});
export type AntigravityAccountRemoveInput = typeof AntigravityAccountRemoveInput.Type;

export const AntigravityAccountDismissInput = Schema.Struct({
  fingerprint: TrimmedNonEmptyString,
});
export type AntigravityAccountDismissInput = typeof AntigravityAccountDismissInput.Type;

export class AntigravityAccountError extends Schema.TaggedErrorClass<AntigravityAccountError>()(
  "AntigravityAccountError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
