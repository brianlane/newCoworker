import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/white-glove/apply-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/white-glove/apply-service")>();
  return {
    ...actual,
    applyWhiteGloveIntake: vi.fn()
  };
});

vi.mock("@/lib/vps/schedule-vault-sync", () => ({
  scheduleVaultSync: vi.fn()
}));

import { POST } from "@/app/api/admin/white-glove-intakes/[id]/apply/route";
import { requireAdmin } from "@/lib/auth";
import {
  applyWhiteGloveIntake,
  WhiteGloveApplyError
} from "@/lib/white-glove/apply-service";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";

const INTAKE_ID = "0f0f0f0f-0000-4000-8000-000000000001";
const BIZ_ID = "056034a7-e84c-444d-8d15-747eeb1fa899";

function applyRequest(body: unknown): Request {
  return new Request(`http://localhost/api/admin/white-glove-intakes/${INTAKE_ID}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function routeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("api/admin/white-glove-intakes/[id]/apply route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(applyWhiteGloveIntake).mockResolvedValue({
      flowId: "44444444-4444-4444-8444-444444444444",
      flowCreated: true,
      businessHoursApplied: true
    });
  });

  it("applies the intake and schedules the vault re-seed", async () => {
    const res = await POST(applyRequest({ businessId: BIZ_ID }), routeParams(INTAKE_ID));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.flowCreated).toBe(true);
    expect(applyWhiteGloveIntake).toHaveBeenCalledWith({
      intakeId: INTAKE_ID,
      businessId: BIZ_ID
    });
    expect(scheduleVaultSync).toHaveBeenCalledWith(BIZ_ID);
  });

  it("rejects non-admins before doing anything", async () => {
    const denied = Object.assign(new Error("Admin only"), { status: 403 });
    vi.mocked(requireAdmin).mockRejectedValue(denied);
    const res = await POST(applyRequest({ businessId: BIZ_ID }), routeParams(INTAKE_ID));
    expect(res.status).toBe(403);
    expect(applyWhiteGloveIntake).not.toHaveBeenCalled();
    expect(scheduleVaultSync).not.toHaveBeenCalled();
  });

  it("400s on a malformed intake id or body", async () => {
    const badId = await POST(applyRequest({ businessId: BIZ_ID }), routeParams("not-a-uuid"));
    expect(badId.status).toBe(400);

    const badBody = await POST(applyRequest({ businessId: "nope" }), routeParams(INTAKE_ID));
    expect(badBody.status).toBe(400);
    expect(applyWhiteGloveIntake).not.toHaveBeenCalled();
  });

  it("maps typed apply errors (pre-write) without scheduling a sync", async () => {
    vi.mocked(applyWhiteGloveIntake).mockRejectedValue(
      new WhiteGloveApplyError("intake_not_found", "Intake not found.")
    );
    const notFound = await POST(applyRequest({ businessId: BIZ_ID }), routeParams(INTAKE_ID));
    expect(notFound.status).toBe(404);

    vi.mocked(applyWhiteGloveIntake).mockRejectedValue(
      new WhiteGloveApplyError("intake_not_completed", "Only a completed questionnaire can be applied.")
    );
    const conflict = await POST(applyRequest({ businessId: BIZ_ID }), routeParams(INTAKE_ID));
    expect(conflict.status).toBe(409);
    const body = await conflict.json();
    expect(body.error.message).toContain("completed questionnaire");
    // Typed errors are all thrown before the first tenant write.
    expect(scheduleVaultSync).not.toHaveBeenCalled();
  });

  it("still re-seeds the vault when an untyped error lands mid-apply", async () => {
    // A DB hiccup after the vault write: central Supabase already holds the
    // new blocks, so the box must be re-seeded even though the route 500s.
    vi.mocked(applyWhiteGloveIntake).mockRejectedValue(new Error("db down"));
    const boom = await POST(applyRequest({ businessId: BIZ_ID }), routeParams(INTAKE_ID));
    expect(boom.status).toBe(500);
    expect(scheduleVaultSync).toHaveBeenCalledWith(BIZ_ID);
  });
});
