/**
 * PATCH /api/integrations/meta, the two intents this route accepts:
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

import { PATCH, POST } from "@/app/api/integrations/meta/route";
import {
  activateMetaConnection,
  getMetaConnection,
  getMetaPageClaim,
  getPublicMetaConnection,
  setMetaConnectionActive,
  setMetaConnectionDataset
} from "@/lib/db/meta-connections";
import { listManagedPages, subscribePageToLeadgen } from "@/lib/meta/client";
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

describe("POST /api/integrations/meta (page pick)", () => {
  const OTHER_BIZ = "22222222-2222-4222-8222-222222222222";
  const PAGE = { id: "page-9", name: "New Coworker", accessToken: "page-tok" };

  function post(body: Record<string, unknown>) {
    return POST(
      new Request("http://localhost/api/integrations/meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      })
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    vi.mocked(requireBusinessRole).mockResolvedValue(OWNER as never);
    vi.mocked(getMetaConnection).mockResolvedValue({
      business_id: BIZ,
      status: "pending",
      page_id: null,
      dataset_id: null,
      userToken: "user-tok"
    } as never);
    vi.mocked(listManagedPages).mockResolvedValue([PAGE] as never);
    vi.mocked(getMetaPageClaim).mockResolvedValue(null as never);
    vi.mocked(activateMetaConnection).mockResolvedValue({
      business_id: BIZ,
      status: "active",
      page_id: PAGE.id
    } as never);
  });

  it("refuses without naming the business that holds the Page", async () => {
    // uq_meta_connections_page is GLOBAL: the holder can be an unrelated
    // customer who merely shares a Facebook Page admin with this caller.
    // Naming them would disclose another tenant's business name, and that
    // they use the product. We never reveal one business to another, so the
    // message stays nameless even when the caller owns both (Bugbot
    // ddcefed0 + Brian, Aug 2026).
    vi.mocked(getMetaPageClaim).mockResolvedValue({ business_id: OTHER_BIZ } as never);

    const res = await post({ businessId: BIZ, pageId: PAGE.id });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("another business");
    expect(json.error.message).toContain("disconnect it there first");
    // No identifier of the holder in any form.
    expect(json.error.message).not.toContain(OTHER_BIZ);
    expect(json.error.message).not.toMatch(/sandbox|acme|dental/i);
    // Refused BEFORE the Meta-side subscribe, so a rejected pick leaves no
    // dangling subscription to clean up.
    expect(subscribePageToLeadgen).not.toHaveBeenCalled();
    expect(activateMetaConnection).not.toHaveBeenCalled();
  });

  it("does not look the holder up at all, so there is nothing to leak", async () => {
    // Cheapest guarantee against regression: the route has no reference to
    // the holding business beyond its id, which it never renders.
    vi.mocked(getMetaPageClaim).mockResolvedValue({ business_id: OTHER_BIZ } as never);
    const res = await post({ businessId: BIZ, pageId: PAGE.id });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain(OTHER_BIZ);
  });

  it("lets a business re-pick the Page it already holds (reconnect)", async () => {
    // Reconnecting to grant new scopes re-picks the same Page; the claim is
    // this business's own, so it must proceed.
    vi.mocked(getMetaPageClaim).mockResolvedValue({ business_id: BIZ } as never);

    const res = await post({ businessId: BIZ, pageId: PAGE.id });
    expect(res.status).toBe(200);
    expect(subscribePageToLeadgen).toHaveBeenCalledWith(PAGE.id, PAGE.accessToken);
    expect(activateMetaConnection).toHaveBeenCalled();
  });

  it("proceeds when no business holds the Page yet", async () => {
    const res = await post({ businessId: BIZ, pageId: PAGE.id });
    expect(res.status).toBe(200);
    expect(activateMetaConnection).toHaveBeenCalled();
  });
});
