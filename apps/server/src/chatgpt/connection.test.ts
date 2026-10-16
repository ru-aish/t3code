import { describe, expect, it } from "@effect/vitest";
import { executionPrompt, stableMessageId } from "./connection.ts";

describe("ChatGPT submission identity", () => {
  it("uses the same valid upstream message ID for a retried durable request", () => {
    expect(stableMessageId("request-one")).toBe(stableMessageId("request-one"));
    expect(stableMessageId("request-one")).not.toBe(stableMessageId("request-two"));
    expect(stableMessageId("request-one")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
  it("injects the stored destination identity into every prompt including continuations", () => {
    for (const text of ["initial request", "follow-up request", "continue"]) {
      const compiled = executionPrompt("registered-id", "/work/project", text);
      expect(compiled).toContain("permanent Terminal MCP thread ID is: registered-id");
      expect(compiled).toContain('Workspace: "/work/project"');
      expect(compiled.endsWith(`\n\n${text}`)).toBe(true);
    }
  });
});
