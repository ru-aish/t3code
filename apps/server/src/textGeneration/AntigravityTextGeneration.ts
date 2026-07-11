// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import {
  type AntigravitySettings,
  type ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import {
  makeAntigravityEnvironment,
  resolveAntigravityAgentApiPath,
  transcriptPathForConversation,
} from "../provider/Layers/AntigravityProvider.ts";
import { parseAntigravityTranscriptLine } from "../provider/Layers/AntigravityAdapter.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import type { TextGenerationShape, ThreadTitleGenerationResult } from "./TextGeneration.ts";

const ANTIGRAVITY_TEXT_GENERATION_TIMEOUT_MS = 180_000;

function runAgentApi(
  settings: AntigravitySettings,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(resolveAntigravityAgentApiPath(settings), [...args], {
      cwd,
      env,
      timeout: 30_000,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || stdout.trim() || `agentapi exited with code ${code}`));
    });
  });
}

function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return undefined;
}

function antigravityModelArg(model: string | undefined): string | undefined {
  const normalized = model?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("flash-lite") || normalized.includes("flash_lite")) {
    return "--model=flash_lite";
  }
  if (normalized.includes("flash")) {
    return "--model=flash";
  }
  if (normalized.includes("pro")) {
    return "--model=pro";
  }
  return undefined;
}

async function waitForStructuredOutput(input: {
  readonly settings: AntigravitySettings;
  readonly conversationId: string;
  readonly startedAtMs: number;
}): Promise<string> {
  const transcriptPath = transcriptPathForConversation(input);
  let offset = 0;
  let lastContent = "";
  while (performance.now() - input.startedAtMs < ANTIGRAVITY_TEXT_GENERATION_TIMEOUT_MS) {
    try {
      const stat = await fs.stat(transcriptPath);
      if (stat.size < offset) offset = 0;
      if (stat.size > offset) {
        const handle = await fs.open(transcriptPath, "r");
        try {
          const buffer = Buffer.alloc(stat.size - offset);
          await handle.read(buffer, 0, buffer.length, offset);
          offset = stat.size;
          for (const line of buffer.toString("utf8").split(/\r?\n/g)) {
            const record = parseAntigravityTranscriptLine(line);
            if (
              record?.source === "MODEL" &&
              typeof record.content === "string" &&
              record.content.trim()
            ) {
              lastContent = record.content;
              const json = extractJsonObject(lastContent);
              if (json) return json;
            }
          }
        } finally {
          await handle.close();
        }
      }
    } catch {
      // The daemon creates the transcript asynchronously.
    }
    await sleep(750);
  }
  throw new Error(
    lastContent
      ? "Timed out waiting for structured Antigravity output."
      : "Timed out waiting for Antigravity transcript output.",
  );
}

export const makeAntigravityTextGeneration = Effect.fn("makeAntigravityTextGeneration")(function* (
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const runJson = Effect.fn("AntigravityTextGeneration.runJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema,
    modelSelection: _modelSelection,
  }: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const schemaJson = JSON.stringify(toJsonSchemaObject(outputSchema));
    const fullPrompt = [
      `<T3_WORKSPACE_CONTEXT>\nCurrent working directory: ${cwd}\nWhen the user refers to "this folder", "here", or the current folder, use this directory.\n</T3_WORKSPACE_CONTEXT>`,
      prompt,
      `Return only a JSON object matching this JSON Schema:\n${schemaJson}`,
    ].join("\n\n");
    const startedAtMs = performance.now();
    const modelArg = antigravityModelArg(_modelSelection.model);
    const env = makeAntigravityEnvironment(settings, environment, cwd);
    const stdout = yield* Effect.tryPromise({
      try: () =>
        runAgentApi(
          settings,
          ["new-conversation", ...(modelArg ? [modelArg] : []), fullPrompt],
          cwd,
          env,
        ),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail:
            cause instanceof Error ? cause.message : "Failed to start Antigravity text generation.",
          cause,
        }),
    });
    const parsed = yield* Effect.try({
      try: () =>
        JSON.parse(stdout) as { response?: { newConversation?: { conversationId?: string } } },
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: "Antigravity agentapi returned invalid JSON.",
          cause,
        }),
    });
    const conversationId = parsed.response?.newConversation?.conversationId;
    if (!conversationId) {
      return yield* new TextGenerationError({
        operation,
        detail: "Antigravity agentapi response did not include a conversation id.",
      });
    }
    const json = yield* Effect.tryPromise({
      try: () => waitForStructuredOutput({ settings, conversationId, startedAtMs }),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: cause instanceof Error ? cause.message : "Failed to read Antigravity output.",
          cause,
        }),
    });
    return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchema))(json).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Antigravity returned invalid structured output.",
            cause,
          }),
      ),
    );
  });

  return {
    generateCommitMessage: (input) => {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });
      return runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      }).pipe(
        Effect.map((generated) => ({
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body.trim(),
          ...("branch" in generated && typeof generated.branch === "string"
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : {}),
        })),
      );
    },
    generatePrContent: (input) => {
      const { prompt, outputSchema } = buildPrContentPrompt(input);
      return runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      }).pipe(
        Effect.map((generated) => ({
          title: sanitizePrTitle(generated.title),
          body: generated.body.trim(),
        })),
      );
    },
    generateBranchName: (input) => {
      const { prompt, outputSchema } = buildBranchNamePrompt(input);
      return runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      }).pipe(Effect.map((generated) => ({ branch: sanitizeBranchFragment(generated.branch) })));
    },
    generateThreadTitle: (input) => {
      const { prompt, outputSchema } = buildThreadTitlePrompt(input);
      return runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      }).pipe(
        Effect.map(
          (generated) =>
            ({
              title: sanitizeThreadTitle(generated.title),
            }) satisfies ThreadTitleGenerationResult,
        ),
      );
    },
  } satisfies TextGenerationShape;
});
