import { describe, expect, it } from "vitest";
import { businessSchema, coworkerLogSchema } from "@/lib/db/schema";

describe("schema validation", () => {
  it("accepts valid business row", () => {
    const parsed = businessSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Mock Realty",
      ownerEmail: "owner@example.com",
      tier: "starter",
      status: "online"
    });
    expect(parsed.name).toBe("Mock Realty");
  });

  it("accepts valid coworker log row", () => {
    const parsed = coworkerLogSchema.parse({
      businessId: "11111111-1111-4111-8111-111111111111",
      taskType: "call",
      status: "urgent_alert",
      logPayload: { summary: "Need owner callback" },
      createdAt: "2026-03-25T00:00:00.000Z"
    });
    expect(parsed.status).toBe("urgent_alert");
  });
});
