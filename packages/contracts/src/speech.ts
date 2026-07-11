import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { SpeechToTextModel } from "./settings.ts";

export const SpeechToTextTranscribeInput = Schema.Struct({
  audioBase64: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  fileName: TrimmedNonEmptyString,
});
export type SpeechToTextTranscribeInput = typeof SpeechToTextTranscribeInput.Type;

export const SpeechToTextTranscribeResult = Schema.Struct({
  text: TrimmedString,
  model: SpeechToTextModel,
});
export type SpeechToTextTranscribeResult = typeof SpeechToTextTranscribeResult.Type;

export class SpeechToTextError extends Schema.TaggedErrorClass<SpeechToTextError>()(
  "SpeechToTextError",
  {
    detail: Schema.String,
    status: Schema.optionalKey(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Speech-to-text error: ${this.detail}`;
  }
}
