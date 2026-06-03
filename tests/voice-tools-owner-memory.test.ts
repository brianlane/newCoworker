import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/configs", () => ({
  getBusinessConfig: vi.fn(),
  patchBusinessConfig: vi.fn()
}));

vi.mock("@/lib/vps/sync-vault", () => ({
  syncVaultToVpsAndLog: vi.fn()
}));

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true)
}));

import { POST } from "@/app/api/voice/tools/owner-append-business-memory/route";
import { getBusinessConfig, patchBusinessConfig } from "@/lib/db/configs";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";
import { verifyRowboatGatewayToken } from "@/lib/rowboat/gateway-token";

const BIZ = "11111111-1111-4111-8111-111111111111";

function makeReq(body: unknown, token = "gw"): Request {
  return new Request("http://localhost/api/voice/tools/owner-append-business-memory", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyRowboatGatewayToken).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/voice/tools/owner-append-business-memory", () => {
  it("401s without gateway bearer", async () => {
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(false);
    const res = await POST(
      makeReq({
        businessId: BIZ,
        args: { bullets: "Never ask for budget." }
      })
    );
    expect(res.status).toBe(401);
  });

  it("rejects when callerE164 is present (customer channels)", async () => {
    const res = await POST(
      makeReq({
        businessId: BIZ,
        callerE164: "+15551234567",
        args: { bullets: "Never ask for budget." }
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "owner_dashboard_only" });
    expect(patchBusinessConfig).not.toHaveBeenCalled();
  });

  it("appends bullets to memory_md and triggers vault sync", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue({
      business_id: BIZ,
      soul_md: "",
      identity_md: "",
      memory_md: "Prior line",
      website_md: "",
      updated_at: ""
    });

    const res = await POST(
      makeReq({
        businessId: BIZ,
        args: { bullets: "Never discuss budget.\nAlways mention brokerage name." }
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.appended).toBe(true);
    expect(json.data.bulletCount).toBe(2);

    expect(patchBusinessConfig).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        memory_md: expect.stringContaining("Prior line")
      })
    );
    const written = vi.mocked(patchBusinessConfig).mock.calls[0][1].memory_md as string;
    expect(written).toMatch(/### Owner chat \(\d{4}-\d{2}-\d{2}\)/);
    expect(written).toContain("- Never discuss budget.");
    expect(written).not.toContain("- - ");
    expect(syncVaultToVpsAndLog).toHaveBeenCalledWith(BIZ);
  });

  it("strips indented markdown bullets without double-prefixing", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue(null);

    const res = await POST(
      makeReq({
        businessId: BIZ,
        args: { bullets: "  - First rule.\n  * Second rule." }
      })
    );
    expect(res.status).toBe(200);
    const written = vi.mocked(patchBusinessConfig).mock.calls[0][1].memory_md as string;
    expect(written).toContain("- First rule.");
    expect(written).toContain("- Second rule.");
    expect(written).not.toMatch(/- - /);
  });

  it("returns savedBullets listing exactly the appended lines", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue(null);
    const res = await POST(
      makeReq({
        businessId: BIZ,
        args: { bullets: "Never discuss budget.\nOffer free estimates." }
      })
    );
    const json = await res.json();
    expect(json.data.savedBullets).toEqual(["Never discuss budget.", "Offer free estimates."]);
    expect(json.data.skippedDuplicates).toBe(0);
  });

  it("skips lines already present in memory_md (normalized) and reports them", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue({
      business_id: BIZ,
      soul_md: "",
      identity_md: "",
      memory_md: "## Owner Rules\n- Never discuss budget.",
      website_md: "",
      updated_at: ""
    });

    const res = await POST(
      makeReq({
        businessId: BIZ,
        // First line is a re-send (differs only by case/trailing punctuation);
        // second is genuinely new.
        args: { bullets: "never discuss budget\nEscalate to Amy Laidlaw 602-695-1142" }
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.appended).toBe(true);
    expect(json.data.savedBullets).toEqual(["Escalate to Amy Laidlaw 602-695-1142"]);
    expect(json.data.skippedDuplicates).toBe(1);
    const written = vi.mocked(patchBusinessConfig).mock.calls[0][1].memory_md as string;
    expect(written).toContain("- Escalate to Amy Laidlaw 602-695-1142");
    // The duplicate is NOT appended a second time (only the pre-existing one).
    expect(written.match(/never discuss budget/gi)?.length).toBe(1);
  });

  it("collapses duplicates within the same batch", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue(null);
    const res = await POST(
      makeReq({
        businessId: BIZ,
        args: { bullets: "Closed on Sundays\n- closed on sundays.\nClosed on Sundays" }
      })
    );
    const json = await res.json();
    expect(json.data.savedBullets).toEqual(["Closed on Sundays"]);
    expect(json.data.bulletCount).toBe(1);
  });

  it("when every line is a duplicate: appended:false, no write, no vault sync", async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue({
      business_id: BIZ,
      soul_md: "",
      identity_md: "",
      memory_md: "- Never discuss budget.",
      website_md: "",
      updated_at: ""
    });

    const res = await POST(
      makeReq({ businessId: BIZ, args: { bullets: "Never discuss budget." } })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.appended).toBe(false);
    expect(json.data.savedBullets).toEqual([]);
    expect(json.data.skippedDuplicates).toBe(1);
    expect(patchBusinessConfig).not.toHaveBeenCalled();
    expect(syncVaultToVpsAndLog).not.toHaveBeenCalled();
  });

  it("rescues a restated rule whose only copy would be truncated from the head", async () => {
    // Head rule, then enough filler that appending the restated rule overflows
    // the cap and tail-truncation would drop the head copy.
    const headRule = "- Always greet customers by name.";
    const filler = Array.from({ length: 400 }, (_, i) => `- Filler rule number ${i} padding text.`).join(
      "\n"
    );
    const big = `${headRule}\n${filler}`;
    expect(big.length).toBeGreaterThan(14_000);

    vi.mocked(getBusinessConfig).mockResolvedValue({
      business_id: BIZ,
      soul_md: "",
      identity_md: "",
      memory_md: big,
      website_md: "",
      updated_at: ""
    });

    const res = await POST(
      makeReq({ businessId: BIZ, args: { bullets: "Always greet customers by name." } })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // Not dropped as a duplicate: re-appended so it survives truncation.
    expect(json.data.appended).toBe(true);
    expect(json.data.savedBullets).toEqual(["Always greet customers by name."]);
    expect(json.data.truncated).toBe(true);
    const written = vi.mocked(patchBusinessConfig).mock.calls[0][1].memory_md as string;
    expect(written).toContain("- Always greet customers by name.");
  });

  it("400 when bullets empty after trim", async () => {
    const res = await POST(
      makeReq({
        businessId: BIZ,
        args: { bullets: "   \n  \t  " }
      })
    );
    expect(res.status).toBe(400);
  });
});
