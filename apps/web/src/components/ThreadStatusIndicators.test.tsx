import { ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ThreadWakeupStatusIndicator,
  ThreadWorktreeIndicator,
  linkedPullRequestSnapshotStatus,
  resolveThreadWakeupPresentation,
} from "./ThreadStatusIndicators";

describe("ThreadWorktreeIndicator", () => {
  it("renders the worktree folder and branch in an accessible label", () => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "feature/sidebar-indicator",
          worktreePath: "/tmp/worktrees/sidebar-indicator",
        }}
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      'aria-label="Worktree: sidebar-indicator (feature/sidebar-indicator)"',
    );
    expect(markup).toContain('data-testid="thread-worktree-thread-1"');
  });

  it.each([null, "", "   "])("renders nothing for an absent worktree path", (worktreePath) => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "main",
          worktreePath,
        }}
      />,
    );

    expect(markup).toBe("");
  });
});

describe("thread wakeup indicators", () => {
  it("describes a scheduled time wake with a compact countdown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
    try {
      const presentation = resolveThreadWakeupPresentation([
        {
          wakeupId: "wake-time",
          kind: "time",
          dueAt: "2026-10-18T12:15:00Z",
          pid: null,
          status: "scheduled",
        },
      ]);
      expect(presentation).toMatchObject({
        icon: "time",
        label: "Wake in 15m",
        pulse: false,
      });
      expect(presentation?.tooltip).toContain("Scheduled wake in 15m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes process waits and due wakeups", () => {
    expect(
      resolveThreadWakeupPresentation([
        {
          wakeupId: "wake-process",
          kind: "process",
          dueAt: null,
          pid: 4242,
          status: "scheduled",
        },
      ]),
    ).toMatchObject({
      icon: "process",
      label: "Waiting for PID 4242",
      pulse: false,
    });

    const due = resolveThreadWakeupPresentation([
      {
        wakeupId: "wake-process",
        kind: "process",
        dueAt: "2026-10-18T12:00:00Z",
        pid: 4242,
        status: "due",
      },
    ]);
    expect(due).toMatchObject({ label: "Wake pending", pulse: true });
  });

  it("renders an accessible sidebar wake indicator", () => {
    const markup = renderToStaticMarkup(
      <ThreadWakeupStatusIndicator
        thread={{
          id: ThreadId.make("thread-wake"),
          pendingWakeups: [
            {
              wakeupId: "wake-process",
              kind: "process",
              dueAt: null,
              pid: 4242,
              status: "scheduled",
            },
          ],
        }}
      />,
    );

    expect(markup).toContain('data-testid="thread-wakeup-status-thread-wake"');
    expect(markup).toContain("Waiting for process PID 4242");
  });
});

describe("linked pull request snapshots", () => {
  const link: ThreadPullRequestLink = {
    host: "gitlab.example.com",
    repository: "acme/web",
    number: 42,
    url: "https://gitlab.example.com/acme/web/-/merge_requests/42",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00Z",
    stack: null,
    snapshot: null,
  };
  it("keeps unsynced links unknown", () => {
    expect(linkedPullRequestSnapshotStatus(link)).toBeNull();
  });
  it("uses the snapshot state and branches with the linked identity", () => {
    const result = linkedPullRequestSnapshotStatus({
      ...link,
      snapshot: {
        state: "merged",
        title: "Change",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: "2026-01-02T00:00:00Z",
        syncedAt: "2026-01-03T00:00:00Z",
      },
    });
    expect(result).toEqual({
      pr: {
        number: 42,
        url: link.url,
        title: "Change",
        state: "merged",
        isDraft: false,
        headRef: "feature",
        baseRef: "main",
        updatedAt: "2026-01-02T00:00:00Z",
      },
      sourceControlProvider: { kind: "gitlab", name: "gitlab", baseUrl: "" },
    });
  });
  it.each([
    ["https://git.cafe/owner/repo/pulls/42", "gitcafe"],
    ["https://staging.git.cafe/owner/repo/pulls/42", "gitcafe"],
    ["https://codeberg.org/owner/repo/pulls/42", "forgejo"],
    ["https://gitlab.example.com/acme/web/-/merge_requests/42", "gitlab"],
    ["https://github.com/owner/repo/pull/42", "github"],
  ])("classifies %s as %s", (url, kind) => {
    const result = linkedPullRequestSnapshotStatus({
      ...link,
      url,
      snapshot: {
        state: "open",
        title: "Change",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: null,
        syncedAt: "2026-01-03T00:00:00Z",
      },
    });
    expect(result?.sourceControlProvider.kind).toBe(kind);
  });
});
