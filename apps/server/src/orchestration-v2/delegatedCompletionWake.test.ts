import { describe, expect, it } from "@effect/vitest";
import { delegatedCompletionWakeDetail } from "./delegatedCompletionWake.ts";

describe("delegated completion wake", () => {
  it("points to durable ID discovery when a single task ID is truncated", () => {
    const taskId = "thread:delegated-task:" + "a".repeat(100);
    const text = delegatedCompletionWakeDetail([taskId]);
    expect(text).toContain("t3_thread_read activity");
    expect(text).toContain("full taskId");
    expect(text).not.toContain(taskId);
  });
});
