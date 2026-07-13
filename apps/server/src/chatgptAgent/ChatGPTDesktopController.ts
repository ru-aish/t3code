// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * Owns the narrowly scoped local ChatGPT Desktop restart needed to expose CDP.
 * It deliberately never searches process names: only the launcher's own PID
 * marker can authorize signalling a process.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import { ChatGPTDesktopBridgeError } from "./ChatGPTDesktopBridge.ts";

const isChatGPTDesktopBridgeError = Schema.is(ChatGPTDesktopBridgeError);

const APP_ID = "codex-desktop";
const START_SCRIPT = "/home/coder/Code/chatgpt-desktop-linux/codex-app/start.sh";
const ELECTRON_EXECUTABLE = "/home/coder/Code/chatgpt-desktop-linux/codex-app/electron";
const PID_FILE = `${process.env.XDG_STATE_HOME ?? `${process.env.HOME ?? ""}/.local/state`}/${APP_ID}/app.pid`;
const CDP_STARTUP_TIMEOUT_MS = 60_000;
const TERMINATION_TIMEOUT_MS = 10_000;
const POLL_MS = 200;

type ControllerDependencies = {
  readonly fetch: (input: URL, init?: RequestInit) => Promise<Response>;
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly readlink: (path: string) => Promise<string>;
  readonly kill: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  readonly spawn: (file: string, args: readonly string[]) => { unref(): void };
  readonly delay: (ms: number) => Promise<void>;
  readonly now: () => number;
};

const liveDependencies: ControllerDependencies = {
  fetch,
  readFile: (path, encoding) => NodeFSP.readFile(path, encoding),
  readlink: (path) => NodeFSP.readlink(path),
  kill: process.kill.bind(process),
  spawn: (file, args) => NodeChildProcess.spawn(file, args, { detached: true, stdio: "ignore" }),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

function loopbackEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const octets = hostname.split(".");
  const loopbackIpv4 =
    octets.length === 4 &&
    octets.every((octet) => /^\d+$/u.test(octet) && Number(octet) <= 255) &&
    octets[0] === "127";
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    !(hostname === "localhost" || hostname === "::1" || loopbackIpv4)
  )
    throw new ChatGPTDesktopBridgeError({
      kind: "unavailable",
      detail: "ChatGPT Desktop CDP endpoint must be a loopback HTTP URL.",
    });
  return url;
}

function debuggingAddress(url: URL): string {
  // Node preserves brackets in URL.hostname for IPv6, while Chromium expects
  // the raw address in --remote-debugging-address.
  return url.hostname.replace(/^\[|\]$/gu, "");
}

async function cdpOpen(endpoint: URL, dependencies: ControllerDependencies): Promise<boolean> {
  try {
    const response = await dependencies.fetch(new URL("/json/version", endpoint), {
      signal: AbortSignal.timeout(750),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function verifiedDesktopPid(
  dependencies: ControllerDependencies,
): Promise<number | undefined> {
  let pid: number;
  try {
    const raw = (await dependencies.readFile(PID_FILE, "utf8")).trim();
    if (!/^\d+$/u.test(raw)) return undefined;
    pid = Number(raw);
    if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
    const [exe, command] = await Promise.all([
      dependencies.readlink(`/proc/${pid}/exe`),
      dependencies.readFile(`/proc/${pid}/cmdline`, "utf8"),
    ]);
    const args = new Set(
      command
        .split("\0")
        .flatMap((record) => record.trim().split(/\s+/u))
        .filter(Boolean),
    );
    return exe === ELECTRON_EXECUTABLE &&
      args.has(`--app-id=${APP_ID}`) &&
      args.has(`--class=${APP_ID}`) &&
      ![...args].some((arg) => arg.startsWith("--type="))
      ? pid
      : undefined;
  } catch {
    return undefined;
  }
}

async function waitForVerifiedPidExit(
  pid: number,
  dependencies: ControllerDependencies,
): Promise<boolean> {
  const deadline = dependencies.now() + TERMINATION_TIMEOUT_MS;
  while (dependencies.now() < deadline) {
    if ((await verifiedDesktopPid(dependencies)) !== pid) return true;
    await dependencies.delay(POLL_MS);
  }
  return (await verifiedDesktopPid(dependencies)) !== pid;
}

async function ensureDesktop(
  endpoint: string,
  dependencies: ControllerDependencies = liveDependencies,
): Promise<void> {
  const url = loopbackEndpoint(endpoint);
  if (!url.port)
    throw new ChatGPTDesktopBridgeError({
      kind: "unavailable",
      detail: "ChatGPT Desktop CDP endpoint must include an explicit loopback HTTP port.",
    });
  if (await cdpOpen(url, dependencies)) return;
  const pid = await verifiedDesktopPid(dependencies);
  if (pid) {
    try {
      dependencies.kill(pid, "SIGTERM");
    } catch {
      // The launcher PID marker is stale or the process has just exited.
    }
    if (!(await waitForVerifiedPidExit(pid, dependencies))) {
      if ((await verifiedDesktopPid(dependencies)) === pid) {
        try {
          dependencies.kill(pid, "SIGKILL");
        } catch {
          // Only the revalidated launcher-recorded main PID can be signalled.
        }
        if (!(await waitForVerifiedPidExit(pid, dependencies)))
          throw new ChatGPTDesktopBridgeError({
            kind: "unavailable",
            detail: "ChatGPT Desktop main process did not exit before relaunch.",
          });
      }
    }
  }
  try {
    dependencies
      .spawn(START_SCRIPT, [
        `--remote-debugging-address=${debuggingAddress(url)}`,
        `--remote-debugging-port=${url.port}`,
      ])
      .unref();
  } catch (cause) {
    throw new ChatGPTDesktopBridgeError({
      kind: "unavailable",
      detail: `Could not launch ChatGPT Desktop: ${String(cause)}`,
    });
  }
  const deadline = dependencies.now() + CDP_STARTUP_TIMEOUT_MS;
  while (dependencies.now() < deadline) {
    if (await cdpOpen(url, dependencies)) return;
    await dependencies.delay(POLL_MS);
  }
  throw new ChatGPTDesktopBridgeError({
    kind: "unavailable",
    detail: "ChatGPT Desktop did not open its loopback CDP endpoint in time.",
  });
}

export interface ChatGPTDesktopControllerShape {
  readonly ensure: (endpoint: string) => Effect.Effect<void, ChatGPTDesktopBridgeError>;
}

export class ChatGPTDesktopController extends Context.Service<
  ChatGPTDesktopController,
  ChatGPTDesktopControllerShape
>()("t3/chatgptAgent/ChatGPTDesktopController") {}

export const ChatGPTDesktopControllerLive = Layer.effect(
  ChatGPTDesktopController,
  Effect.sync(() => {
    // A burst of turns can arrive while CDP is down. Coalescing the recovery
    // prevents concurrent callers from killing/relaunching the same desktop.
    const inFlight = new Map<string, Promise<void>>();
    return {
      ensure: (endpoint: string) =>
        Effect.tryPromise({
          try: () => {
            const existing = inFlight.get(endpoint);
            if (existing) return existing;
            const attempt = ensureDesktop(endpoint).finally(() => inFlight.delete(endpoint));
            inFlight.set(endpoint, attempt);
            return attempt;
          },
          catch: (cause) =>
            isChatGPTDesktopBridgeError(cause)
              ? cause
              : new ChatGPTDesktopBridgeError({
                  kind: "unavailable",
                  detail: "Could not prepare ChatGPT Desktop.",
                }),
        }),
    } satisfies ChatGPTDesktopControllerShape;
  }),
);

export const ChatGPTDesktopControllerTest = {
  ensureDesktop,
  debuggingAddress,
  loopbackEndpoint,
  verifiedDesktopPid,
  paths: { electron: ELECTRON_EXECUTABLE, launcher: START_SCRIPT },
};
