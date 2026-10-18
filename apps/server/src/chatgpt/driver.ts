import * as ChatGPTActions from "./actions.ts";
// @effect-diagnostics nodeBuiltinImport:off -- A stable local environment namespace is derived from its state path.
import * as NodeCrypto from "node:crypto";
import { ChatGPTSettings, TextGenerationError, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
} from "@t3tools/provider-core/server/driver";
import { ChatGPTConnection, type ChatGPTModel } from "./connection.ts";
import * as ChatGPTMcpBridge from "./mcpBridge.ts";
import { CHATGPT_DRIVER, makeChatGPTAdapter } from "./adapter.ts";

export type ChatGPTDriverEnv =
  | ProviderHost.ProviderHost
  | FileSystem.FileSystem
  | Path.Path
  | McpProviderSessions.McpProviderSessions;
const decodeSettings = Schema.decodeSync(ChatGPTSettings);

export const ChatGPTDriver: ProviderDriver<ChatGPTSettings, ChatGPTDriverEnv> = {
  driverKind: CHATGPT_DRIVER,
  metadata: { displayName: "ChatGPT", supportsMultipleInstances: true },
  configSchema: ChatGPTSettings,
  defaultConfig: () => decodeSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const actions = yield* ChatGPTActions.ChatGPTActions;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* HostProcess.HomeDirectory;
      const host = yield* ProviderHost.ProviderHost;
      const cacheDir = path.join(host.paths.stateDir, "chatgpt", input.instanceId);
      const environmentId = NodeCrypto.createHash("sha256")
        .update(host.paths.stateDir)
        .digest("hex")
        .slice(0, 32);
      const tokenPath = input.config.controlTokenFile.startsWith("~/")
        ? path.join(home, input.config.controlTokenFile.slice(2))
        : input.config.controlTokenFile;
      const token = input.enabled
        ? yield* fs.readFileString(tokenPath).pipe(Effect.map((v) => v.trim()))
        : "";
      const control = new ChatGPTConnection({
        cdpEndpoint: input.config.cdpEndpoint,
        controlEndpoint: input.config.terminalEndpoint,
        token,
        environmentId,
        providerId: input.instanceId,
        threadId: "catalog",
        cacheDir,
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => control.close()));
      const changes = yield* PubSub.unbounded<ServerProvider>();
      let models: ChatGPTModel[] = [];
      let fetchedAt = 0;
      const modelsPath = path.join(cacheDir, "models.json");
      const cached = yield* fs.readFileString(modelsPath).pipe(Effect.orElseSucceed(() => "null"));
      const ModelCache = Schema.Struct({
        fetchedAt: Schema.Number,
        models: Schema.Array(
          Schema.Struct({
            slug: Schema.String,
            name: Schema.optional(Schema.String),
            thinking_efforts: Schema.optional(Schema.Array(Schema.String)),
            is_default: Schema.Boolean,
            is_available: Schema.Boolean,
          }),
        ),
      });
      const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ModelCache))(
        cached,
      ).pipe(Effect.option);
      if (decoded._tag === "Some") {
        models = [...decoded.value.models];
        fetchedAt = decoded.value.fetchedAt;
      }
      let checkedAt = DateTime.formatIso(yield* DateTime.now);
      const snapshotValue = (ready: boolean): ServerProvider => ({
        instanceId: input.instanceId,
        driver: CHATGPT_DRIVER,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        enabled: input.enabled,
        installed: ready,
        version: null,
        status: !input.enabled ? "disabled" : ready ? "ready" : "warning",
        auth: { status: ready ? "authenticated" : "unknown", type: "ChatGPT Desktop" },
        checkedAt,
        models: models.map((m) => ({
          slug: m.slug,
          name: m.name ?? m.slug,
          isCustom: false,
          isDefault: m.is_default,
          capabilities: {
            optionDescriptors: (m.thinking_efforts ?? []).length
              ? [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select",
                    options: m.thinking_efforts!.map((id) => ({
                      id,
                      label: id[0]!.toUpperCase() + id.slice(1),
                    })),
                    currentValue: m.thinking_efforts![0],
                  },
                ]
              : [],
          },
        })),
        slashCommands: [],
        skills: [],
        supportsTextGeneration: false,
        supportsConversationRollback: false,
        supportedRuntimeModes: ["full-access"],
        showInteractionModeToggle: false,
        message: input.enabled
          ? "Uses the authenticated ChatGPT app and T3 Terminal MCP."
          : "Enable to connect ChatGPT and Terminal MCP.",
        continuation: { groupKey: `chatgpt:${input.instanceId}` },
      });
      let current = snapshotValue(models.length > 0);
      let forceModels = models.some((model) => model.thinking_efforts === undefined);
      const refreshLock = yield* Semaphore.make(1);
      const refresh = Effect.gen(function* () {
        if (!input.enabled) return current;
        const result = yield* Effect.tryPromise({
          try: () => control.health(),
          catch: (cause) =>
            new ProviderDriverError({
              driver: CHATGPT_DRIVER,
              instanceId: input.instanceId,
              detail: "ChatGPT renderer check failed",
              cause,
            }),
        }).pipe(Effect.result);
        const timestamp = yield* Clock.currentTimeMillis;
        checkedAt = DateTime.formatIso(yield* DateTime.now);
        if (
          result._tag === "Success" &&
          (forceModels || !models.length || timestamp - fetchedAt > 86_400_000)
        ) {
          const loaded = yield* Effect.tryPromise({
            try: () => control.models(),
            catch: (cause) =>
              new ProviderDriverError({
                driver: CHATGPT_DRIVER,
                instanceId: input.instanceId,
                detail: "ChatGPT renderer check failed",
                cause,
              }),
          }).pipe(Effect.result);
          if (loaded._tag === "Success") {
            models = loaded.success;
            forceModels = false;
            fetchedAt = timestamp;
            yield* fs.makeDirectory(cacheDir, { recursive: true });
            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ModelCache))({
              models,
              fetchedAt,
            });
            yield* fs.writeFileString(modelsPath, encoded);
          }
        }
        current = snapshotValue(result._tag === "Success" && models.length > 0);
        yield* PubSub.publish(changes, current);
        return current;
      }).pipe(
        refreshLock.withPermits(1),
        Effect.orElseSucceed(() => current),
      );
      // The registry subscribes to driver changes; it does not initiate discovery.
      // Probe once on activation so a cold cache needs no manual model refresh.
      if (input.enabled) yield* refresh.pipe(Effect.forkScoped);
      const unsupported = () =>
        Effect.fail(
          new TextGenerationError({
            operation: "chatgpt",
            detail: "Select another provider for text generation.",
          }),
        );
      return {
        instanceId: input.instanceId,
        driverKind: CHATGPT_DRIVER,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: input.enabled,
        continuationIdentity: defaultProviderContinuationIdentity({
          driverKind: CHATGPT_DRIVER,
          instanceId: input.instanceId,
        }),
        cloudProjects: {
          list: () =>
            Effect.tryPromise({
              try: () => control.projects(),
              catch: (cause) =>
                new ProviderDriverError({
                  driver: CHATGPT_DRIVER,
                  instanceId: input.instanceId,
                  detail: "Could not load ChatGPT projects",
                  cause,
                }),
            }),
          create: (name: string) =>
            Effect.tryPromise({
              try: () => control.createProject(name),
              catch: (cause) =>
                new ProviderDriverError({
                  driver: CHATGPT_DRIVER,
                  instanceId: input.instanceId,
                  detail: "Could not create ChatGPT project",
                  cause,
                }),
            }),
        },
        refreshModels: () =>
          Effect.sync(() => {
            forceModels = true;
          }).pipe(Effect.andThen(refresh), Effect.asVoid),
        snapshot: {
          getSnapshot: Effect.sync(() => current),
          refresh,
          streamChanges: Stream.fromPubSub(changes),
          applyUsageLimits: () => Effect.void,
          resolveMaintenance: () =>
            Effect.succeed({ provider: CHATGPT_DRIVER, packageName: null, update: null }),
        },
        orchestrationAdapter: makeChatGPTAdapter(input, {
          token,
          environmentId,
          cacheDir,
          attachMcp: yield* ChatGPTMcpBridge.make,
          resolveAttachmentPath: host.resolveAttachmentPath,
          linkPullRequest: actions.linkPullRequest,
        }),
        textGeneration: {
          generateCommitMessage: unsupported,
          generatePrContent: unsupported,
          generateBranchName: unsupported,
          generateThreadTitle: unsupported,
          generateReviewGuide: unsupported,
        },
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: CHATGPT_DRIVER,
            instanceId: input.instanceId,
            detail: "ChatGPT connection setup failed",
            cause,
          }),
      ),
    ),
};
