import { describe, expect, it } from "vite-plus/test";

import {
  threadRelationshipStatusIndicatorClassName,
  threadRelationshipStatusLabel,
} from "./ThreadRelationshipIcon";

describe("thread relationship forced status", () => {
  it("presents forced as a success-like terminal status", () => {
    expect(threadRelationshipStatusLabel("forced")).toBe("Forced");
    expect(threadRelationshipStatusIndicatorClassName("forced")).toBe("bg-success");
  });
});
