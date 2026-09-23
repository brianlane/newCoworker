import { describe, expect, it, vi } from "vitest";
import { ownerAllowsFlowDelete } from "@/lib/ai-flows/flow-delete-confirm";

describe("ownerAllowsFlowDelete", () => {
  it("asks with the flow name and stops the delete when the owner cancels", () => {
    const confirm = vi.fn((message: string) => {
      expect(message).toContain('Delete "Lead follow-up (white-glove build)"?');
      expect(message).toContain("stops running");
      expect(message).not.toContain("\u2014");
      return false;
    });
    expect(ownerAllowsFlowDelete("Lead follow-up (white-glove build)", confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("lets the delete proceed only after the owner confirms", () => {
    expect(ownerAllowsFlowDelete("Clinic sheet patient call", () => true)).toBe(true);
  });
});
