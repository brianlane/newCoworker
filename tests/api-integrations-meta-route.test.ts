/**
 * PATCH /api/integrations/meta — the two intents this route accepts:
 * soft-disable/re-enable, and setting the owner-entered Conversions API
 * dataset id (Meta's platform flow has the ADVERTISER create the dataset in
 * Events Manager, so it is an input, never something we discover).
 *
 * Route files sit outside the coverage gate (`src/lib/**`), so these are
 * hand-written rather than implied by the threshold.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/db/meta-connections", () => ({
  activateMetaConnection: vi.fn(),
  deleteMetaConnection: vi.fn(),
  getMetaConnection: vi.fn(),
  getMetaPageClaim: vi.fn(),
  getPublicMetaConnection: vi.fn(),
  setMetaConnectionActive: vi.fn(),
  setMetaConnectionDataset: vi.fn()
}));

vi.mock("@/lib/meta/client", () => ({
  getLinkedInstagramAccount: vi.fn(),
  listManagedPages: vi.fn(),
  subscribePageToLeadgen: vi.fn(),
  unsubscribePage: vi.fn()
}));

import { PATCH } from "@/app/api/integrations/meta/route";
import {
  getPublicMetaConnection,
  setMetaConnectionActive,
  setMetaConnectionDataset
} from "@/lib/db/meta-connections";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OWNER = { userId: "u1", email: "owner@example.com", isAdmin: false };
const CONNECTED = {
  business_id: BIZ,
  status: "active" as const,
  page_id: "page-9",
  dataset_id: null,
  capi_enabled: true,
  is_active: true
};

function patch(body: Record<string, unknown>) {
  return PATCH(
    new Request("http://localhost/api/integrations/meta", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

describe("PATCH /api/integrations/meta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    vi.mocked(requireBusinessRole).mockResolvedValue(OWNER as never);
    vi.mocked(getPublicMetaConnection).mockResolvedValue(CONNECTED as never);
    vi.mocked(setMetaConnectionActive).mockResolvedValue(CONNECTED as never);
    vi.mocked(setMetaConnectionDataset).mockResolvedValue({
      ...CONNECTED,
      dataset_id: "1234567890123456"
    } as never);
  });

  it("saves a numeric dataset id and returns the updated row", async () => {
    const res = await patch({ businessId: BIZ, datasetId: "1234567890123456" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { dataset_id: string } };
    expect(json.data.dataset_id).toBe("1234567890123456");
    expect(setMetaConnectionDataset).toHaveBeenCalledWith(BIZ, "1234567890123456");
    expect(setMetaConnectionActive).not.toHaveBeenCalled();
  });

  it("treats an empty string as clearing the dataset (feedback loop off)", async () => {
    vi.mocked(setMetaConnectionDataset).mockResolvedValue({
      ...CONNECTED,
      dataset_id: null
    } as never);
    const res = await patch({ businessId: BIZ, datasetId: "" });
    expect(res.status).toBe(200);
    expect(setMetaConnectionDataset).toHaveBeenCalledWith(BIZ, null);
  });

  it("rejects a non-numeric dataset id instead of storing a value every upload would 400 on", async () => {
    const res = await patch({ businessId: BIZ, datasetId: "ds_abc" });
    expect(res.status).toBe(400);
    expect(setMetaConnectionDataset).not.toHaveBeenCalled();
  });

  it("refuses both intents at once, and neither", async () => {
    expect((await patch({ businessId: BIZ, isActive: false, datasetId: "1" })).status).toBe(400);
    expect((await patch({ businessId: BIZ })).status).toBe(400);
    expect(setMetaConnectionDataset).not.toHaveBeenCalled();
    expect(setMetaConnectionActive).not.toHaveBeenCalled();
  });

  it("explains that a dataset needs a connected Page when no ACTIVE row matched", async () => {
    vi.mocked(setMetaConnectionDataset).mockResolvedValue(null as never);
    const res = await patch({ businessId: BIZ, datasetId: "1234567890123456" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toMatch(/Pick the Page/i);
  });

  it("still soft-disables through the isActive intent", async () => {
    const res = await patch({ businessId: BIZ, isActive: false });
    expect(res.status).toBe(200);
    expect(setMetaConnectionActive).toHaveBeenCalledWith(BIZ, false);
    expect(setMetaConnectionDataset).not.toHaveBeenCalled();
  });

  it("404s when the business has no Meta connection at all", async () => {
    vi.mocked(getPublicMetaConnection).mockResolvedValue(null as never);
    const res = await patch({ businessId: BIZ, datasetId: "1234567890123456" });
    expect(res.status).toBe(404);
    expect(setMetaConnectionDataset).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await patch({ businessId: BIZ, datasetId: "1234567890123456" });
    expect(res.status).toBe(401);
  });
});
