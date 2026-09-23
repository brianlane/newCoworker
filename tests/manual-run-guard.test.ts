import { describe, expect, it } from "vitest";
import { blankManualExtractRefusal } from "@/lib/ai-flows/manual-run-guard";

describe("blankManualExtractRefusal", () => {
  const extractFirst = {
    steps: [{ type: "extract_text", id: "s1" }, { type: "send_email", id: "s2" }]
  };

  it("refuses only a blank run whose first step reads the message", () => {
    const refused = blankManualExtractRefusal(extractFirst, undefined);
    expect(refused).toContain("Paste a sample message first");
    expect(blankManualExtractRefusal(extractFirst, "   ")).toBe(refused);
    expect(blankManualExtractRefusal(extractFirst, "name: Ada")).toBeNull();
    expect(blankManualExtractRefusal({ steps: [{ type: "send_email" }] }, "")).toBeNull();
    expect(blankManualExtractRefusal({ steps: [null] }, "")).toBeNull();
    expect(blankManualExtractRefusal({ steps: "nope" as unknown as never[] }, "")).toBeNull();
    expect(blankManualExtractRefusal(null, "")).toBeNull();
    expect(blankManualExtractRefusal(undefined, "")).toBeNull();
  });
});
