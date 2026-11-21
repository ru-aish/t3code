import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import {
  makeChatGPTBackendManager,
  type ChatGPTBackendTargetConfig,
  type SystemdExecResult,
} from "./backendManager.ts";

const DEFAULT_CONFIG: ChatGPTBackendTargetConfig = {
  cdpEndpoint: "http://127.0.0.1:9234",
  terminalEndpoint: "http://127.0.0.1:8022",
  controlTokenFile: "~/.config/terminal-mcp-t3/control-token",
  autoStartEnabled: true,
};

function showOutput(activeState: string, subState: string, loadState = "loaded", result = "success") {
  return [
    `LoadState=${loadState}`,
    `ActiveState=${activeState}`,
    `SubState=${subState}`,
    `Result=${result}`,
  ].join("\n");
}

describe("ChatGPTBackendManager", () => {
  it("reports ready when all systemd units are active and endpoints are healthy", async () => {
    const manager = makeChatGPTBackendManager({
      platform: "linux",
      homeDir: "/home/tester",
      now: () => "2026-11-21T16:00:00.000Z",
      sleep: async () => {},
      readTokenFile: async () => "secret-token",
      probeHttp: async () => ({ ok: true, status: 200 }),
      execSystemctl: async (args): Promise<SystemdExecResult> => {
        if (args[0] === "--version") return { exitCode: 0, stdout: "systemd 256", stderr: "" };
        return { exitCode: 0, stdout: showOutput("active", "running"), stderr: "" };
      },
    });

    const status = await Effect.runPromise(manager.getStatus(DEFAULT_CONFIG));
    expect(status.systemdAvailable).toBe(true);
    expect(status.overallStatus).toBe("ready");
    expect(status.services).toHaveLength(3);
    expect(status.services.every((s) => s.state === "running" && s.healthy === true)).toBe(true);
  });

  it("ensureStarted starts only stopped units in dependency order without disrupting running ones", async () => {
    const states: Record<string, string> = {
      "terminal-mcp-t3.service": "active",
      "terminal-cloudflared-t3.service": "inactive",
      "chatgpt-local-desktop.service": "inactive",
    };
    const commands: string[][] = [];

    const manager = makeChatGPTBackendManager({
      platform: "linux",
      homeDir: "/home/tester",
      now: () => "2026-11-21T16:00:00.000Z",
      sleep: async () => {},
      readTokenFile: async () => "secret-token",
      probeHttp: async (url) => {
        if (url.includes("9234")) {
          return states["chatgpt-local-desktop.service"] === "active"
            ? { ok: true, status: 200 }
            : { ok: false, detail: "ECONNREFUSED" };
        }
        return states["terminal-mcp-t3.service"] === "active"
          ? { ok: true, status: 200 }
          : { ok: false, detail: "ECONNREFUSED" };
      },
      execSystemctl: async (args): Promise<SystemdExecResult> => {
        commands.push([...args]);
        if (args[0] === "--version") return { exitCode: 0, stdout: "systemd 256", stderr: "" };
        if (args[0] === "show") {
          const unit = args[args.length - 1]!;
          const active = states[unit] ?? "inactive";
          return {
            exitCode: 0,
            stdout: showOutput(active, active === "active" ? "running" : "dead"),
            stderr: "",
          };
        }
        if (args[0] === "start") {
          const unit = args[1]!;
          states[unit] = "active";
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const status = await Effect.runPromise(manager.ensureStarted(DEFAULT_CONFIG));
    expect(status.overallStatus).toBe("ready");
    const startCalls = commands.filter((c) => c[0] === "start").map((c) => c[1]);
    expect(startCalls).toEqual([
      "terminal-cloudflared-t3.service",
      "chatgpt-local-desktop.service",
    ]);
  });

  it("stops services in reverse dependency order and supports single-service restart", async () => {
    const states: Record<string, string> = {
      "terminal-mcp-t3.service": "active",
      "terminal-cloudflared-t3.service": "active",
      "chatgpt-local-desktop.service": "active",
    };
    const controlCalls: Array<[string, string]> = [];

    const manager = makeChatGPTBackendManager({
      platform: "linux",
      homeDir: "/home/tester",
      now: () => "2026-11-21T16:00:00.000Z",
      sleep: async () => {},
      readTokenFile: async () => "secret-token",
      probeHttp: async (url) => {
        const unit = url.includes("9234") ? "chatgpt-local-desktop.service" : "terminal-mcp-t3.service";
        return states[unit] === "active"
          ? { ok: true, status: 200 }
          : { ok: false, detail: "ECONNREFUSED" };
      },
      execSystemctl: async (args): Promise<SystemdExecResult> => {
        if (args[0] === "--version") return { exitCode: 0, stdout: "systemd 256", stderr: "" };
        if (args[0] === "show") {
          const unit = args[args.length - 1]!;
          const active = states[unit] ?? "inactive";
          return {
            exitCode: 0,
            stdout: showOutput(active, active === "active" ? "running" : "dead"),
            stderr: "",
          };
        }
        if (args[0] === "stop" || args[0] === "restart") {
          const unit = args[1]!;
          controlCalls.push([args[0], unit]);
          states[unit] = args[0] === "stop" ? "inactive" : "active";
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const stopped = await Effect.runPromise(manager.control(DEFAULT_CONFIG, { action: "stop" }));
    expect(stopped.overallStatus).toBe("stopped");
    expect(controlCalls).toEqual([
      ["stop", "chatgpt-local-desktop.service"],
      ["stop", "terminal-cloudflared-t3.service"],
      ["stop", "terminal-mcp-t3.service"],
    ]);

    controlCalls.length = 0;
    const restarted = await Effect.runPromise(
      manager.control(DEFAULT_CONFIG, { action: "restart", serviceId: "terminal-mcp-t3" }),
    );
    expect(controlCalls).toEqual([["restart", "terminal-mcp-t3.service"]]);
    expect(restarted.overallStatus).toBe("degraded");
  });

  it("reports degraded when a unit is active but its HTTP endpoint is unreachable", async () => {
    const manager = makeChatGPTBackendManager({
      platform: "linux",
      homeDir: "/home/tester",
      now: () => "2026-11-21T16:00:00.000Z",
      sleep: async () => {},
      readTokenFile: async () => "secret-token",
      probeHttp: async (url) =>
        url.includes("9234")
          ? { ok: false, detail: "ECONNREFUSED" }
          : { ok: true, status: 200 },
      execSystemctl: async (args): Promise<SystemdExecResult> => {
        if (args[0] === "--version") return { exitCode: 0, stdout: "systemd 256", stderr: "" };
        return { exitCode: 0, stdout: showOutput("active", "running"), stderr: "" };
      },
    });

    const status = await Effect.runPromise(manager.getStatus(DEFAULT_CONFIG));
    expect(status.overallStatus).toBe("degraded");
    const desktop = status.services.find((s) => s.id === "chatgpt-desktop");
    expect(desktop?.healthy).toBe(false);
    expect(desktop?.detail).toContain("ECONNREFUSED");
  });

  it("gracefully degrades on non-Linux platforms and rejects systemd control", async () => {
    const manager = makeChatGPTBackendManager({
      platform: "darwin",
      homeDir: "/Users/tester",
      now: () => "2026-11-21T16:00:00.000Z",
      sleep: async () => {},
      readTokenFile: async () => null,
      probeHttp: async () => ({ ok: false, detail: "ECONNREFUSED" }),
    });

    const status = await Effect.runPromise(manager.getStatus(DEFAULT_CONFIG));
    expect(status.systemdAvailable).toBe(false);
    expect(status.overallStatus).toBe("unavailable");
    expect(status.services.every((s) => s.canControl === false)).toBe(true);

    const exit = await Effect.runPromiseExit(manager.control(DEFAULT_CONFIG, { action: "start" }));
    expect(exit._tag).toBe("Failure");
  });
});
