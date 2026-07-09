import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateComplianceModule: vi.fn()
}));

vi.mock("@/lib/db/configs", () => ({
  getBusinessConfig: vi.fn(),
  patchBusinessConfig: vi.fn()
}));

vi.mock("@/lib/vps/schedule-vault-sync", () => ({
  scheduleVaultSync: vi.fn()
}));

import { POST } from "@/app/api/admin/compliance-module/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateComplianceModule } from "@/lib/db/businesses";
import { getBusinessConfig, patchBusinessConfig } from "@/lib/db/configs";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";
import { COMPLIANCE_MODULE_START } from "@/lib/compliance/module";
import { BUSINESS_CONFIG_SOUL_MD_MAX_CHARS } from "@/lib/vault/business-config-markdown-limits";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";
const MODULE = {
  customPrompt: "Never quote settlement amounts on any channel.",
  forbiddenTerms: ["merger"]
};

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/admin/compliance-module", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

describe("api/admin/compliance-module route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID, tier: "enterprise" } as never);
    vi.mocked(getBusinessConfig).mockResolvedValue({
      soul_md: "# soul.md\nBe helpful.\n"
    } as never);
  });

  it("saves the module, rewrites soul_md, and schedules a vault sync", async () => {
    const res = await post({ businessId: BIZ_ID, complianceModule: MODULE });
    expect(res.status).toBe(200);
    expect(updateComplianceModule).toHaveBeenCalledWith(BIZ_ID, MODULE);
    const patch = vi.mocked(patchBusinessConfig).mock.calls[0];
    expect(patch[0]).toBe(BIZ_ID);
    expect((patch[1] as { soul_md: string }).soul_md).toContain(COMPLIANCE_MODULE_START);
    expect((patch[1] as { soul_md: string }).soul_md).toContain("Be helpful.");
    expect(scheduleVaultSync).toHaveBeenCalledWith(BIZ_ID);
  });

  it("clears the module (allowed on any tier) and strips the soul block", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID, tier: "standard" } as never);
    vi.mocked(getBusinessConfig).mockResolvedValue({
      soul_md: `# soul.md\nBe helpful.\n\n${COMPLIANCE_MODULE_START}\nold\n<!-- CUSTOM_COMPLIANCE_MODULE_END -->\n`
    } as never);

    const res = await post({ businessId: BIZ_ID, complianceModule: null });
    expect(res.status).toBe(200);
    expect(updateComplianceModule).toHaveBeenCalledWith(BIZ_ID, null);
    const patched = (vi.mocked(patchBusinessConfig).mock.calls[0][1] as { soul_md: string })
      .soul_md;
    expect(patched).not.toContain(COMPLIANCE_MODULE_START);
  });

  it("refuses setting a module on non-enterprise tiers", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID, tier: "starter" } as never);
    const res = await post({ businessId: BIZ_ID, complianceModule: MODULE });
    expect(res.status).toBe(400);
    expect(updateComplianceModule).not.toHaveBeenCalled();
  });

  it("skips the soul rewrite for unprovisioned tenants (no config yet)", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue(null);
    const res = await post({ businessId: BIZ_ID, complianceModule: MODULE });
    expect(res.status).toBe(200);
    expect(updateComplianceModule).toHaveBeenCalled();
    expect(patchBusinessConfig).not.toHaveBeenCalled();
    expect(scheduleVaultSync).not.toHaveBeenCalled();
  });

  it("refuses when the module would push the soul past the size cap", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue({
      // 10 chars of headroom — any module block overflows it.
      soul_md: "x".repeat(BUSINESS_CONFIG_SOUL_MD_MAX_CHARS - 10)
    } as never);
    const res = await post({ businessId: BIZ_ID, complianceModule: MODULE });
    expect(res.status).toBe(400);
    expect(patchBusinessConfig).not.toHaveBeenCalled();
    expect(updateComplianceModule).not.toHaveBeenCalled();
  });

  it("404s on missing businesses and validates payloads", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const missing = await post({ businessId: BIZ_ID, complianceModule: null });
    expect(missing.status).toBe(404);

    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID, tier: "enterprise" } as never);
    const invalid = await post({
      businessId: BIZ_ID,
      complianceModule: { customPrompt: "short" }
    });
    expect(invalid.status).toBe(400);
  });
});
