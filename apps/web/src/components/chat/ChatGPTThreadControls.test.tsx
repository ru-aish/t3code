import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  driver: "chatgpt",
  nativeId: "6ad4cf4f-afd0-83e8-9d19-e046787a84f4",
  allowed: true,
  refresh: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("~/state/entities", () => ({
  useThreadProjection: () => ({
    projection: {
      thread: { activeProviderThreadId: "native-thread" },
      providerThreads: [
        {
          id: "native-thread",
          driver: state.driver,
          nativeThreadRef: { nativeId: state.nativeId },
        },
      ],
    },
  }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { refreshChatGPTThread: { permissionAtom: () => null } },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.refresh }));
vi.mock("./ThreadDetailsSection", () => ({
  ThreadDetailsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("./ThreadDetailsControl", () => ({
  ThreadDetailsControl: ({
    render,
    children,
    part: _part,
    ...props
  }: {
    render?: React.ReactElement;
    children: ReactNode;
    part?: string;
  }) =>
    render ? (
      <a {...(render.props as object)} {...props}>
        {children}
      </a>
    ) : (
      <button {...props}>{children}</button>
    ),
}));
import { ChatGPTThreadControls } from "./ChatGPTThreadControls";
let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  state.driver = "chatgpt";
  state.allowed = true;
  state.refresh.mockReset();
});

it("opens the exact web conversation and prevents repeated refresh while synchronizing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const gate = Promise.withResolvers<{ _tag: "Success"; value: { messageCount: number } }>();
  state.refresh.mockReturnValue(gate.promise);
  act(() => {
    renderer = create(
      <ChatGPTThreadControls
        environmentId={EnvironmentId.make("environment")}
        threadId={ThreadId.make("thread")}
      />,
    );
  });
  expect(renderer.root.findByType("a").props.href).toBe(`https://chatgpt.com/c/${state.nativeId}`);
  expect(renderer.root.findByType("a").props.target).toBe("_blank");
  act(() => {
    void renderer.root.findByType("button").props.onClick();
  });
  expect(renderer.root.findByType("button").props.disabled).toBe(true);
  act(() => {
    void renderer.root.findByType("button").props.onClick();
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  expect(state.refresh).toHaveBeenCalledWith({
    environmentId: "environment",
    input: { threadId: "thread" },
  });
  await act(async () => {
    gate.resolve({ _tag: "Success", value: { messageCount: 3 } });
    await gate.promise;
  });
  expect(renderer.root.findByType("button").props.disabled).toBe(false);
  expect(renderer.root.findByProps({ role: "status" }).children).toEqual([
    "Conversation refreshed",
  ]);
});

it("keeps web access available for read-only users and hides controls for other providers", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = false;
  act(() => {
    renderer = create(
      <ChatGPTThreadControls
        environmentId={EnvironmentId.make("environment")}
        threadId={ThreadId.make("thread")}
      />,
    );
  });
  expect(renderer.root.findByType("button").props.disabled).toBe(true);
  expect(renderer.root.findByType("a").props.href).toContain(state.nativeId);
  state.driver = "codex";
  act(() => {
    renderer.update(
      <ChatGPTThreadControls
        environmentId={EnvironmentId.make("environment")}
        threadId={ThreadId.make("thread")}
      />,
    );
  });
  expect(renderer.toJSON()).toBeNull();
});
