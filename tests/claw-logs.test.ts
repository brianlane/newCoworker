import { describe, expect, it } from "vitest";
import { evaluateUrgency, parseClawLog } from "@/lib/claw/logs";

const baseLog = {
  businessId: "11111111-1111-4111-8111-111111111111",
  taskType: "call" as const,
  status: "success" as const,
  logPayload: { summary: "done" },
  createdAt: "2026-03-25T00:00:00.000Z"
};

describe("claw logs", () => {
  it("parses valid payload", () => {
    const parsed = parseClawLog(baseLog);
    expect(parsed.taskType).toBe("call");
  });

  it("evaluates non-urgent events", () => {
    const parsed = parseClawLog(baseLog);
    expect(evaluateUrgency(parsed)).toEqual({
      shouldNotify: false,
      summary: "call:success"
    });
  });

  it("evaluates urgent events", () => {
    const parsed = parseClawLog({
      ...baseLog,
      status: "urgent_alert"
    });
    expect(evaluateUrgency(parsed)).toEqual({
      shouldNotify: true,
      summary: "URGENT call"
    });
  });
});
