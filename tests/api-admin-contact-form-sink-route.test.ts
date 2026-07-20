/**
 * POST /api/admin/contact-form-sink — the operator toggle behind the admin
 * "Contact form (platform)" card.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/db/contact-form-sink", () => ({
  getContactFormSinkBusinessId: vi.fn(),
  setContactFormSink: vi.fn()
}));

vi.mock("@/lib/db/logs", () => ({
  insertCoworkerLog: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/admin/contact-form-sink/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import {
  getContactFormSinkBusinessId,
  setContactFormSink
} from "@/lib/db/contact-form-sink";
import { insertCoworkerLog } from "@/lib/db/logs";
import { logger } from "@/lib/logger";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/contact-form-sink", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/admin/contact-form-sink route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({} as never);
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID } as never);
    vi.mocked(getContactFormSinkBusinessId).mockResolvedValue(OTHER_ID);
    vi.mocked(setContactFormSink).mockResolvedValue(undefined);
    vi.mocked(insertCoworkerLog).mockResolvedValue(undefined as never);
  });

  it("designates the sink, audit-logs, and reports the previous holder", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, enabled: true }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      businessId: BIZ_ID,
      enabled: true,
      previousSinkBusinessId: OTHER_ID
    });
    expect(setContactFormSink).toHaveBeenCalledWith(BIZ_ID, true);
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ_ID,
        log_payload: expect.objectContaining({
          action: "contact_form_sink_updated",
          enabled: true,
          previousSinkBusinessId: OTHER_ID
        })
      })
    );
  });

  it("undesignates without touching other businesses", async () => {
    vi.mocked(getContactFormSinkBusinessId).mockResolvedValue(BIZ_ID);
    const res = await POST(makeRequest({ businessId: BIZ_ID, enabled: false }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.enabled).toBe(false);
    expect(setContactFormSink).toHaveBeenCalledWith(BIZ_ID, false);
  });

  it("404s on an unknown business", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    const res = await POST(makeRequest({ businessId: BIZ_ID, enabled: true }));
    expect(res.status).toBe(404);
    expect(setContactFormSink).not.toHaveBeenCalled();
  });

  it("rejects an invalid body with VALIDATION_ERROR", async () => {
    const res = await POST(makeRequest({ businessId: "not-a-uuid", enabled: true }));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("continues (and warns) when the audit log insert fails", async () => {
    vi.mocked(insertCoworkerLog).mockRejectedValue(new Error("log down"));
    const res = await POST(makeRequest({ businessId: BIZ_ID, enabled: true }));
    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      "contact-form-sink: audit log insert failed",
      expect.objectContaining({ businessId: BIZ_ID })
    );
  });

  it("propagates auth failures through handleRouteError", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("nope"));
    const res = await POST(makeRequest({ businessId: BIZ_ID, enabled: true }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(setContactFormSink).not.toHaveBeenCalled();
  });
});
