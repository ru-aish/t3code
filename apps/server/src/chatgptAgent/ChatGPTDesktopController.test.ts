import { assert, describe, it } from "@effect/vitest";

import { ChatGPTDesktopControllerTest } from "./ChatGPTDesktopController.ts";

const paths = ChatGPTDesktopControllerTest.paths;

function dependencies(
  overrides: Partial<Parameters<typeof ChatGPTDesktopControllerTest.ensureDesktop>[1]> = {},
) {
  return {
    fetch: async () => new Response("{}", { status: 200 }),
    readFile: async () => "",
    readlink: async () => "",
    kill: () => true,
    spawn: () => ({ unref() {} }),
    delay: async () => {},
    now: () => 0,
    ...overrides,
  };
}

describe("ChatGPTDesktopController", () => {
  it("uses the installed launcher and electron paths and does nothing when CDP is already open", async () => {
    let spawned = false;
    await ChatGPTDesktopControllerTest.ensureDesktop(
      "http://127.0.0.1:9337",
      dependencies({
        spawn: (() => {
          spawned = true;
          throw new Error("must not spawn");
        }) as never,
      }),
    );
    assert.equal(paths.launcher, "/home/coder/Code/chatgpt-desktop-linux/codex-app/start.sh");
    assert.equal(paths.electron, "/home/coder/Code/chatgpt-desktop-linux/codex-app/electron");
    assert.isFalse(spawned);
  });

  it("verifies flattened Chromium cmdlines and excludes renderer/helper processes", async () => {
    const flattened = await ChatGPTDesktopControllerTest.verifiedDesktopPid(
      dependencies({
        readFile: async (path) =>
          String(path).endsWith("app.pid")
            ? "42\n"
            : `${paths.electron} --app-id=codex-desktop --class=codex-desktop`,
        readlink: async () => paths.electron,
      }),
    );
    assert.equal(flattened, 42);
    const renderer = await ChatGPTDesktopControllerTest.verifiedDesktopPid(
      dependencies({
        readFile: async (path) =>
          String(path).endsWith("app.pid")
            ? "42\n"
            : `${paths.electron}\0--app-id=codex-desktop --class=codex-desktop --type=renderer`,
        readlink: async () => paths.electron,
      }),
    );
    assert.isUndefined(renderer);
  });

  it("waits for the exact verified main PID to exit before safely relaunching", async () => {
    const signals: Array<[number, NodeJS.Signals | number | undefined]> = [];
    const launches: Array<{ file: string; args: readonly string[] }> = [];
    let running = true;
    let probes = 0;
    await ChatGPTDesktopControllerTest.ensureDesktop(
      "http://127.0.0.1:9337",
      dependencies({
        fetch: async () => new Response("{}", { status: ++probes > 1 ? 200 : 503 }),
        readFile: async (path) =>
          String(path).endsWith("app.pid")
            ? "42\n"
            : running
              ? `${paths.electron}\0--app-id=codex-desktop\0--class=codex-desktop\0`
              : "",
        readlink: async () => paths.electron,
        kill: (pid, signal) => {
          signals.push([pid, signal]);
          if (signal === "SIGTERM") running = false;
          return true;
        },
        spawn: (file, args) => {
          launches.push({ file, args });
          return { unref() {} };
        },
      }),
    );
    assert.deepEqual(signals, [[42, "SIGTERM"]]);
    assert.deepEqual(launches, [
      {
        file: paths.launcher,
        args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9337"],
      },
    ]);
  });

  it("rejects invalid endpoints and leaves stale or unverified PID markers unsignalled", async () => {
    assert.throws(() => ChatGPTDesktopControllerTest.loopbackEndpoint("http://192.168.1.2:9337"));
    assert.throws(() => ChatGPTDesktopControllerTest.loopbackEndpoint("http://127.0.0.999:9337"));
    assert.equal(
      ChatGPTDesktopControllerTest.debuggingAddress(new URL("http://[::1]:9337")),
      "::1",
    );
    try {
      await ChatGPTDesktopControllerTest.ensureDesktop("http://127.0.0.1", dependencies());
      assert.fail("Expected an endpoint without a port to be rejected");
    } catch (error) {
      assert.match(String(error), /explicit loopback HTTP port/u);
    }
    const signals: number[] = [];
    let probes = 0;
    await ChatGPTDesktopControllerTest.ensureDesktop(
      "http://127.0.0.1:9337",
      dependencies({
        fetch: async () => new Response("{}", { status: ++probes > 1 ? 200 : 503 }),
        readFile: async (path) => (String(path).endsWith("app.pid") ? "42\n" : "--bad"),
        readlink: async () => paths.electron,
        kill: (pid) => {
          signals.push(pid);
          return true;
        },
      }),
    );
    assert.deepEqual(signals, []);
  });
});
