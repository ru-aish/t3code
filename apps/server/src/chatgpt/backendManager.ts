// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off -- Host systemd/HTTP boundary for ChatGPT backend services.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ChatGPTBackendControlError,
  type ChatGPTBackendAction,
  type ChatGPTBackendOverallStatus,
  type ChatGPTBackendServiceId,
  type ChatGPTBackendServiceState,
  type ChatGPTBackendServiceStatus,
  type ChatGPTBackendStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface ChatGPTBackendTargetConfig {
  readonly cdpEndpoint: string;
  readonly terminalEndpoint: string;
  readonly controlTokenFile: string;
  readonly autoStartEnabled: boolean;
}

export interface SystemdExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnErrorCode?: string | undefined;
}

export interface HttpProbeResult {
  readonly ok: boolean;
  readonly status?: number | undefined;
  readonly detail?: string | undefined;
}

export interface ChatGPTBackendRuntimeDeps {
  readonly platform: string;
  readonly homeDir: string;
  readonly now: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly execSystemctl: (args: ReadonlyArray<string>, timeoutMs: number) => Promise<SystemdExecResult>;
  readonly probeHttp: (
    url: string,
    options?: { readonly headers?: Record<string, string>; readonly timeoutMs?: number },
  ) => Promise<HttpProbeResult>;
  readonly readTokenFile: (filePath: string) => Promise<string | null>;
}

interface ServiceDefinition {
  readonly id: ChatGPTBackendServiceId;
  readonly unitName: string;
  readonly label: string;
  readonly description: string;
}

const isChatGPTBackendControlError = Schema.is(ChatGPTBackendControlError);

const SERVICE_DEFINITIONS: ReadonlyArray<ServiceDefinition> = [
  {
    id: "terminal-mcp-t3",
    unitName: "terminal-mcp-t3.service",
    label: "T3 Terminal MCP Server",
    description: "Isolated T3 Terminal MCP server and private control plane.",
  },
  {
    id: "terminal-cloudflared-t3",
    unitName: "terminal-cloudflared-t3.service",
    label: "T3 Terminal MCP Tunnel",
    description: "Dedicated Cloudflare tunnel exposing T3 Terminal MCP to ChatGPT.",
  },
  {
    id: "chatgpt-desktop",
    unitName: "chatgpt-local-desktop.service",
    label: "ChatGPT Desktop Daemon",
    description: "Authenticated local ChatGPT desktop renderer (CDP).",
  },
];

const START_ORDER: ReadonlyArray<ChatGPTBackendServiceId> = [
  "terminal-mcp-t3",
  "terminal-cloudflared-t3",
  "chatgpt-desktop",
];

const STOP_ORDER: ReadonlyArray<ChatGPTBackendServiceId> = [
  "chatgpt-desktop",
  "terminal-cloudflared-t3",
  "terminal-mcp-t3",
];

function expandHome(homeDir: string, filePath: string): string {
  if (filePath.startsWith("~/")) {
    return NodePath.join(homeDir, filePath.slice(2));
  }
  return filePath;
}

function defaultExecSystemctl(
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<SystemdExecResult> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "systemctl",
      ["--user", ...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const err = error as NodeJS.ErrnoException & { code?: string | number };
        const spawnErrorCode = typeof err.code === "string" ? err.code : undefined;
        const exitCode = typeof err.code === "number" ? err.code : 1;
        resolve({
          exitCode,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? err.message ?? ""),
          spawnErrorCode,
        });
      },
    );
  });
}

async function defaultProbeHttp(
  url: string,
  options?: { readonly headers?: Record<string, string>; readonly timeoutMs?: number },
): Promise<HttpProbeResult> {
  const timeoutMs = options?.timeoutMs ?? 2_500;
  try {
    const response = await fetch(url, {
      method: "GET",
      ...(options?.headers ? { headers: options.headers } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        detail: `HTTP ${response.status}`,
      };
    }
    return { ok: true, status: response.status };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, detail };
  }
}

async function defaultReadTokenFile(filePath: string): Promise<string | null> {
  try {
    const content = await NodeFSP.readFile(filePath, "utf8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function parseSystemctlShow(stdout: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    props[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  return props;
}

function derivePublicHealthUrl(terminalEndpoint: string): string | null {
  try {
    const parsed = new URL(terminalEndpoint);
    if (parsed.port === "8022") {
      parsed.port = "8021";
      parsed.pathname = "/healthz";
      parsed.search = "";
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeEndpoint(endpoint: string, pathname: string): string {
  const parsed = new URL(endpoint);
  parsed.pathname = pathname;
  parsed.search = "";
  return parsed.toString();
}

function mapUnitState(
  loadState: string | undefined,
  activeState: string | undefined,
  subState: string | undefined,
): ChatGPTBackendServiceState {
  if (loadState === "not-found") return "unavailable";
  if (activeState === "active") return "running";
  if (activeState === "activating" || activeState === "reloading") return "starting";
  if (activeState === "failed") return "failed";
  if (activeState === "inactive" || activeState === "deactivating") {
    return subState === "failed" ? "failed" : "stopped";
  }
  return "unavailable";
}

function computeOverallStatus(
  services: ReadonlyArray<ChatGPTBackendServiceStatus>,
): ChatGPTBackendOverallStatus {
  if (services.length === 0) return "unavailable";
  const allUnavailable = services.every(
    (service) => service.state === "unavailable" && service.healthy !== true,
  );
  if (allUnavailable) return "unavailable";

  const allReady = services.every(
    (service) =>
      (service.state === "running" && service.healthy !== false) ||
      (service.state === "unavailable" && service.healthy === true),
  );
  if (allReady) return "ready";

  const anyActiveOrHealthy = services.some(
    (service) =>
      service.state === "running" || service.state === "starting" || service.healthy === true,
  );
  if (anyActiveOrHealthy) return "degraded";
  return "stopped";
}

export interface ChatGPTBackendManagerShape {
  readonly getStatus: (
    config: ChatGPTBackendTargetConfig,
  ) => Effect.Effect<ChatGPTBackendStatus, ChatGPTBackendControlError>;
  readonly control: (
    config: ChatGPTBackendTargetConfig,
    input: { readonly action: ChatGPTBackendAction; readonly serviceId?: ChatGPTBackendServiceId },
  ) => Effect.Effect<ChatGPTBackendStatus, ChatGPTBackendControlError>;
  readonly ensureStarted: (
    config: ChatGPTBackendTargetConfig,
  ) => Effect.Effect<ChatGPTBackendStatus, ChatGPTBackendControlError>;
}

export function makeChatGPTBackendManager(
  overrides?: Partial<ChatGPTBackendRuntimeDeps>,
): ChatGPTBackendManagerShape {
  const deps: ChatGPTBackendRuntimeDeps = {
    platform: overrides?.platform ?? process.platform,
    homeDir: overrides?.homeDir ?? NodeOS.homedir(),
    now: overrides?.now ?? (() => new Date().toISOString()),
    sleep: overrides?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    execSystemctl: overrides?.execSystemctl ?? defaultExecSystemctl,
    probeHttp: overrides?.probeHttp ?? defaultProbeHttp,
    readTokenFile: overrides?.readTokenFile ?? defaultReadTokenFile,
  };

  let controlMutex: Promise<void> = Promise.resolve();
  const serialize = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = controlMutex;
    let release!: () => void;
    controlMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

  const checkSystemdAvailable = async (): Promise<boolean> => {
    if (deps.platform !== "linux") return false;
    const probe = await deps.execSystemctl(["--version"], 3_000);
    if (probe.spawnErrorCode === "ENOENT") return false;
    return probe.exitCode === 0;
  };

  const inspectUnit = async (
    unitName: string,
    systemdAvailable: boolean,
  ): Promise<{
    readonly state: ChatGPTBackendServiceState;
    readonly activeState: string | null;
    readonly subState: string | null;
    readonly canControl: boolean;
    readonly detail: string | null;
  }> => {
    if (!systemdAvailable) {
      return {
        state: "unavailable",
        activeState: null,
        subState: null,
        canControl: false,
        detail:
          deps.platform === "linux"
            ? "systemd user manager unavailable"
            : `Automatic systemd service control is only available on Linux (current: ${deps.platform})`,
      };
    }
    const result = await deps.execSystemctl(
      ["show", "--no-pager", "--property=LoadState,ActiveState,SubState,Result", unitName],
      4_000,
    );
    if (result.exitCode !== 0 && result.stdout.trim().length === 0) {
      return {
        state: "unavailable",
        activeState: null,
        subState: null,
        canControl: false,
        detail: result.stderr.trim() || "Unable to query systemd user unit",
      };
    }
    const props = parseSystemctlShow(result.stdout);
    const loadState = props["LoadState"];
    const activeState = props["ActiveState"] ?? null;
    const subState = props["SubState"] ?? null;
    const unitResult = props["Result"];
    const state = mapUnitState(loadState, activeState ?? undefined, subState ?? undefined);
    const canControl = loadState !== "not-found";
    let detail: string | null = null;
    if (loadState === "not-found") {
      detail = `User unit ${unitName} is not installed`;
    } else if (state === "failed" && unitResult && unitResult !== "success") {
      detail = `Unit failed (${unitResult})`;
    }
    return { state, activeState, subState, canControl, detail };
  };

  const probeService = async (
    definition: ServiceDefinition,
    config: ChatGPTBackendTargetConfig,
    systemdAvailable: boolean,
  ): Promise<ChatGPTBackendServiceStatus> => {
    const unit = await inspectUnit(definition.unitName, systemdAvailable);
    let endpoint: string | null = null;
    let healthy: boolean | null = null;
    let detail = unit.detail;

    if (definition.id === "chatgpt-desktop") {
      endpoint = config.cdpEndpoint;
      try {
        const probeUrl = normalizeEndpoint(config.cdpEndpoint, "/json/list");
        const probe = await deps.probeHttp(probeUrl, { timeoutMs: 2_500 });
        healthy = probe.ok;
        if (!probe.ok && unit.state === "running") {
          detail = probe.detail ? `CDP probe failed: ${probe.detail}` : "CDP endpoint unreachable";
        }
      } catch (cause) {
        healthy = false;
        detail = cause instanceof Error ? cause.message : "Invalid CDP endpoint URL";
      }
    } else if (definition.id === "terminal-mcp-t3") {
      endpoint = config.terminalEndpoint;
      const tokenPath = expandHome(deps.homeDir, config.controlTokenFile);
      const token = await deps.readTokenFile(tokenPath);
      if (token) {
        try {
          const probeUrl = new URL("/v1/events", config.terminalEndpoint);
          probeUrl.searchParams.set("environmentId", "healthcheck");
          probeUrl.searchParams.set("providerId", "healthcheck");
          probeUrl.searchParams.set("afterSeq", "0");
          probeUrl.searchParams.set("waitSeconds", "0");
          const probe = await deps.probeHttp(probeUrl.toString(), {
            headers: { authorization: `Bearer ${token}` },
            timeoutMs: 2_500,
          });
          healthy = probe.ok;
          if (!probe.ok && unit.state === "running") {
            detail = probe.detail
              ? `Control endpoint probe failed: ${probe.detail}`
              : "Control endpoint unreachable";
          }
        } catch (cause) {
          healthy = false;
          detail = cause instanceof Error ? cause.message : "Invalid Terminal MCP endpoint URL";
        }
      } else {
        const publicHealth = derivePublicHealthUrl(config.terminalEndpoint);
        if (publicHealth) {
          const probe = await deps.probeHttp(publicHealth, { timeoutMs: 2_500 });
          healthy = probe.ok;
          detail = probe.ok
            ? `Control token file missing or unreadable (${config.controlTokenFile})`
            : "Control token missing and healthz unreachable";
        } else {
          healthy = false;
          detail = `Control token file missing or unreadable (${config.controlTokenFile})`;
        }
      }
    } else if (definition.id === "terminal-cloudflared-t3") {
      endpoint = null;
      healthy = systemdAvailable ? unit.state === "running" : null;
    }

    const effectiveState: ChatGPTBackendServiceState =
      unit.state === "unavailable" && healthy === true ? "running" : unit.state;

    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      unitName: definition.unitName,
      state: effectiveState,
      activeState: unit.activeState,
      subState: unit.subState,
      endpoint,
      healthy,
      detail,
      canControl: unit.canControl,
    };
  };

  const readStatus = async (config: ChatGPTBackendTargetConfig): Promise<ChatGPTBackendStatus> => {
    const systemdAvailable = await checkSystemdAvailable();
    const services = await Promise.all(
      SERVICE_DEFINITIONS.map((definition) => probeService(definition, config, systemdAvailable)),
    );
    const overallStatus = computeOverallStatus(services);
    return {
      checkedAt: deps.now(),
      platform: deps.platform,
      systemdAvailable,
      autoStartEnabled: config.autoStartEnabled,
      overallStatus,
      cdpEndpoint: config.cdpEndpoint,
      terminalEndpoint: config.terminalEndpoint,
      services,
      error: null,
    };
  };

  const runControl = async (
    config: ChatGPTBackendTargetConfig,
    input: { readonly action: ChatGPTBackendAction; readonly serviceId?: ChatGPTBackendServiceId },
  ): Promise<ChatGPTBackendStatus> => {
    const before = await readStatus(config);
    if (!before.systemdAvailable) {
      throw new ChatGPTBackendControlError({
        detail:
          deps.platform === "linux"
            ? "systemd user session is unavailable; cannot control ChatGPT backend services."
            : `ChatGPT backend service control requires Linux systemd (current platform: ${deps.platform}).`,
      });
    }

    const order = input.action === "stop" ? STOP_ORDER : START_ORDER;
    const targetIds = input.serviceId ? [input.serviceId] : [...order];
    const byId = new Map(before.services.map((service) => [service.id, service] as const));
    const actionable = targetIds
      .map((id) => byId.get(id))
      .filter((service): service is ChatGPTBackendServiceStatus => service !== undefined);

    const unitsToRun: string[] = [];
    for (const service of actionable) {
      if (!service.canControl) {
        if (input.serviceId) {
          throw new ChatGPTBackendControlError({
            detail: `${service.label} (${service.unitName}) is not installed as a systemd user unit.`,
          });
        }
        continue;
      }
      if (input.action === "ensure") {
        // Only start services that are not already running; never disrupt active ChatGPT streams.
        if (service.state !== "running") {
          unitsToRun.push(service.unitName);
        }
      } else {
        unitsToRun.push(service.unitName);
      }
    }

    if (unitsToRun.length === 0) {
      return before;
    }

    const verb = input.action === "ensure" ? "start" : input.action;
    const errors: string[] = [];
    for (const unitName of unitsToRun) {
      const result = await deps.execSystemctl([verb, unitName], 20_000);
      if (result.exitCode !== 0) {
        const msg = result.stderr.trim() || `exit code ${result.exitCode}`;
        errors.push(`${unitName}: ${msg}`);
      }
    }

    // After start/restart/ensure, wait briefly for endpoints to become reachable.
    let status = await readStatus(config);
    if (verb === "start" || verb === "restart") {
      const targetSet = new Set(targetIds);
      const isTargetsHealthy = (candidate: ChatGPTBackendStatus) =>
        candidate.services
          .filter((service) => targetSet.has(service.id) && service.canControl)
          .every((service) => service.state === "running" && service.healthy !== false);

      for (let attempt = 0; attempt < 15 && !isTargetsHealthy(status); attempt += 1) {
        await deps.sleep(400);
        status = await readStatus(config);
      }
    }

    if (errors.length > 0) {
      return {
        ...status,
        error: errors.join("; "),
      };
    }
    return status;
  };

  return {
    getStatus: (config) =>
      Effect.tryPromise({
        try: () => readStatus(config),
        catch: (cause) =>
          isChatGPTBackendControlError(cause)
            ? cause
            : new ChatGPTBackendControlError({
                detail: "Failed to check ChatGPT backend status.",
                cause,
              }),
      }),
    control: (config, input) =>
      Effect.tryPromise({
        try: () => serialize(() => runControl(config, input)),
        catch: (cause) =>
          isChatGPTBackendControlError(cause)
            ? cause
            : new ChatGPTBackendControlError({
                detail: `Failed to ${input.action} ChatGPT backend services.`,
                cause,
              }),
      }),
    ensureStarted: (config) =>
      Effect.tryPromise({
        try: () => serialize(() => runControl(config, { action: "ensure" })),
        catch: (cause) =>
          isChatGPTBackendControlError(cause)
            ? cause
            : new ChatGPTBackendControlError({
                detail: "Failed to auto-start ChatGPT backend services.",
                cause,
              }),
      }),
  };
}

export class ChatGPTBackendManager extends Context.Reference<ChatGPTBackendManagerShape>(
  "t3/chatgpt/ChatGPTBackendManager",
  {
    defaultValue: () => makeChatGPTBackendManager(),
  },
) {}
