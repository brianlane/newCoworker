import { describe, expect, it } from "vitest";

import {
  complianceModuleSchema,
  parseComplianceModule,
  renderComplianceModuleSection,
  applyComplianceModuleToSoul,
  hasRestrictedTerm,
  COMPLIANCE_MODULE_START,
  COMPLIANCE_MODULE_END
} from "@/lib/compliance/module";

const MODULE = {
  customPrompt: "Never quote settlement amounts on any channel.",
  forbiddenTerms: ["pending litigation", "merger"]
};

describe("complianceModuleSchema / parseComplianceModule", () => {
  it("accepts a full module and strips unknown keys", () => {
    expect(complianceModuleSchema.parse({ ...MODULE, extra: 1 })).toEqual(MODULE);
  });

  it("rejects out-of-bounds values", () => {
    expect(complianceModuleSchema.safeParse({ customPrompt: "short" }).success).toBe(false);
    expect(complianceModuleSchema.safeParse({ customPrompt: "x".repeat(2001) }).success).toBe(
      false
    );
    expect(complianceModuleSchema.safeParse({ forbiddenTerms: [] }).success).toBe(false);
    expect(complianceModuleSchema.safeParse({ forbiddenTerms: ["a"] }).success).toBe(false);
    expect(
      complianceModuleSchema.safeParse({
        forbiddenTerms: Array.from({ length: 51 }, (_, i) => `term-${i}`)
      }).success
    ).toBe(false);
  });

  it("parse returns null for null/garbage/empty modules", () => {
    expect(parseComplianceModule(null)).toBeNull();
    expect(parseComplianceModule("junk")).toBeNull();
    expect(parseComplianceModule({})).toBeNull();
    expect(parseComplianceModule({ customPrompt: "x" })).toBeNull();
    expect(parseComplianceModule(MODULE)).toEqual(MODULE);
  });

  it("parse accepts prompt-only and terms-only modules", () => {
    expect(parseComplianceModule({ customPrompt: MODULE.customPrompt })).toEqual({
      customPrompt: MODULE.customPrompt
    });
    expect(parseComplianceModule({ forbiddenTerms: ["merger"] })).toEqual({
      forbiddenTerms: ["merger"]
    });
  });
});

describe("renderComplianceModuleSection", () => {
  it("wraps tenant text inside the fixed additive framing with markers", () => {
    const section = renderComplianceModuleSection(MODULE);
    expect(section.startsWith(COMPLIANCE_MODULE_START)).toBe(true);
    expect(section.endsWith(COMPLIANCE_MODULE_END)).toBe(true);
    expect(section).toContain("IN ADDITION TO (never instead of)");
    expect(section).toContain(MODULE.customPrompt);
    expect(section).toContain("- pending litigation");
    expect(section).toContain("- merger");
  });

  it("renders prompt-only and terms-only variants", () => {
    expect(renderComplianceModuleSection({ customPrompt: MODULE.customPrompt })).not.toContain(
      "restricted topics"
    );
    expect(
      renderComplianceModuleSection({ forbiddenTerms: ["merger"] })
    ).toContain("restricted topics");
  });
});

describe("applyComplianceModuleToSoul", () => {
  const soul = "# soul.md\nBe helpful.\n\n## Compliance\nFollow the law.\n";

  it("appends a block when absent and replaces it on re-save", () => {
    const first = applyComplianceModuleToSoul(soul, MODULE);
    expect(first).toContain(COMPLIANCE_MODULE_START);
    expect(first).toContain("Be helpful.");

    const updated = applyComplianceModuleToSoul(first, {
      customPrompt: "Updated guardrail text for the tenant."
    });
    expect(updated).toContain("Updated guardrail text for the tenant.");
    expect(updated).not.toContain(MODULE.customPrompt);
    // Exactly one block.
    expect(updated.split(COMPLIANCE_MODULE_START).length).toBe(2);
  });

  it("strips the block when cleared, preserving owner content", () => {
    const withBlock = applyComplianceModuleToSoul(soul, MODULE);
    const cleared = applyComplianceModuleToSoul(withBlock, null);
    expect(cleared).not.toContain(COMPLIANCE_MODULE_START);
    expect(cleared).toContain("Be helpful.");
    expect(cleared).toContain("## Compliance");
  });

  it("handles empty soul documents", () => {
    const fresh = applyComplianceModuleToSoul("", MODULE);
    expect(fresh.startsWith(COMPLIANCE_MODULE_START)).toBe(true);
    expect(applyComplianceModuleToSoul("", null)).toBe("");
  });
});

describe("hasRestrictedTerm", () => {
  it("matches case-insensitively and only when a module has terms", () => {
    expect(hasRestrictedTerm("Any updates on the MERGER?", MODULE)).toBe(true);
    expect(hasRestrictedTerm("Nothing sensitive here", MODULE)).toBe(false);
    expect(hasRestrictedTerm("merger", null)).toBe(false);
    expect(hasRestrictedTerm("merger", { customPrompt: MODULE.customPrompt })).toBe(false);
  });
});
