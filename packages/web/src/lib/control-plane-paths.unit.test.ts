import { describe, expect, it } from "vitest";
import { controlPlanePath } from "./control-plane-paths";

describe("controlPlanePath", () => {
  it("builds canonical root and child task paths", () => {
    expect(controlPlanePath("research-agent")).toBe("/research-agent/root");
    expect(controlPlanePath("research-agent", "task-venue")).toBe("/research-agent/task-venue");
  });

  it("encodes path segments independently", () => {
    expect(controlPlanePath("agent one", "task/two")).toBe("/agent%20one/task%2Ftwo");
  });
});
