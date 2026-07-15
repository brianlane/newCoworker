import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  createWhiteGloveIntake,
  listWhiteGloveIntakes,
  getWhiteGloveIntake,
  getWhiteGloveIntakeByToken,
  submitWhiteGloveIntake,
  revokeWhiteGloveIntake,
  claimWhiteGloveIntakeForBusiness,
  markWhiteGloveIntakeApplied,
  whiteGloveIntakeUrl
} from "@/lib/white-glove/intake";
import type { IntakeAnswers } from "@/lib/white-glove/template";

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: [], error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides
  };
}

const INTAKE = {
  id: "0f0f0f0f-0000-4000-8000-000000000001",
  token: "0f0f0f0f-0000-4000-8000-0000000000aa",
  business_name: "Acme Home Services",
  industry: "home_services",
  recipient_email: "prospect@example.com",
  business_id: null,
  answers: null,
  status: "sent",
  created_by: "admin@test.com",
  created_at: "2026-07-01T00:00:00Z",
  completed_at: null
};

const ANSWERS = { business_hours: "Mon–Fri 9–5" } as unknown as IntakeAnswers;

describe("white-glove/intake DB layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createWhiteGloveIntake inserts and returns the row (with email, without, business-tied)", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: INTAKE, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const row = await createWhiteGloveIntake({
      businessName: INTAKE.business_name,
      industry: INTAKE.industry,
      recipientEmail: INTAKE.recipient_email,
      createdBy: INTAKE.created_by
    });
    expect(row).toEqual(INTAKE);
    expect(db.insert).toHaveBeenCalledWith({
      business_name: INTAKE.business_name,
      industry: INTAKE.industry,
      recipient_email: INTAKE.recipient_email,
      business_id: null,
      created_by: INTAKE.created_by
    });

    // Email-less creation: the admin just gets a shareable link.
    await createWhiteGloveIntake({
      businessName: "Solo Law",
      industry: "legal",
      createdBy: INTAKE.created_by
    });
    expect(db.insert).toHaveBeenLastCalledWith(
      expect.objectContaining({ business_name: "Solo Law", recipient_email: null })
    );

    await createWhiteGloveIntake({
      businessName: INTAKE.business_name,
      industry: INTAKE.industry,
      recipientEmail: INTAKE.recipient_email,
      businessId: "biz-1",
      createdBy: INTAKE.created_by
    });
    expect(db.insert).toHaveBeenLastCalledWith(
      expect.objectContaining({ business_id: "biz-1" })
    );
  });

  it("createWhiteGloveIntake throws on error", async () => {
    const db = mockDb({
      single: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(
      createWhiteGloveIntake({
        businessName: "Acme",
        industry: "other",
        recipientEmail: "p@x.com",
        createdBy: "a@b.c"
      })
    ).rejects.toThrow("createWhiteGloveIntake: boom");
  });

  it("listWhiteGloveIntakes returns rows newest-first ([], rows, error)", async () => {
    const db = mockDb({ order: vi.fn().mockResolvedValue({ data: [INTAKE], error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listWhiteGloveIntakes()).toEqual([INTAKE]);
    expect(db.order).toHaveBeenCalledWith("created_at", { ascending: false });

    const empty = mockDb({ order: vi.fn().mockResolvedValue({ data: null, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(empty as never);
    expect(await listWhiteGloveIntakes()).toEqual([]);

    const err = mockDb({
      order: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(err as never);
    await expect(listWhiteGloveIntakes()).rejects.toThrow("listWhiteGloveIntakes: boom");
  });

  it("getWhiteGloveIntake returns the row, null, or throws", async () => {
    const db = mockDb({ maybeSingle: vi.fn().mockResolvedValue({ data: INTAKE, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await getWhiteGloveIntake(INTAKE.id)).toEqual(INTAKE);
    expect(db.eq).toHaveBeenCalledWith("id", INTAKE.id);

    const missing = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(missing as never);
    expect(await getWhiteGloveIntake(INTAKE.id)).toBeNull();

    const err = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(err as never);
    await expect(getWhiteGloveIntake(INTAKE.id)).rejects.toThrow("getWhiteGloveIntake: boom");
  });

  it("getWhiteGloveIntakeByToken resolves the public link's intake (row, null, error)", async () => {
    const db = mockDb({ maybeSingle: vi.fn().mockResolvedValue({ data: INTAKE, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await getWhiteGloveIntakeByToken("tok-1")).toEqual(INTAKE);
    expect(db.eq).toHaveBeenCalledWith("token", "tok-1");

    const missing = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(missing as never);
    expect(await getWhiteGloveIntakeByToken("tok-1")).toBeNull();

    const err = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(err as never);
    await expect(getWhiteGloveIntakeByToken("tok-1")).rejects.toThrow(
      "getWhiteGloveIntakeByToken: boom"
    );
  });

  it("submitWhiteGloveIntake claims only SENT rows and reports whether it landed", async () => {
    const db = mockDb({
      select: vi.fn().mockResolvedValue({ data: [{ id: INTAKE.id }], error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await submitWhiteGloveIntake("tok-1", ANSWERS)).toBe(true);
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({ answers: ANSWERS, status: "completed" })
    );
    // The immutability guard: only a still-open questionnaire accepts answers.
    expect(db.eq).toHaveBeenCalledWith("token", "tok-1");
    expect(db.eq).toHaveBeenCalledWith("status", "sent");

    for (const data of [[], null]) {
      const none = mockDb({ select: vi.fn().mockResolvedValue({ data, error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(none as never);
      expect(await submitWhiteGloveIntake("tok-1", ANSWERS)).toBe(false);
    }
  });

  it("submitWhiteGloveIntake throws on error", async () => {
    const db = mockDb({
      select: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(submitWhiteGloveIntake("tok-1", ANSWERS)).rejects.toThrow(
      "submitWhiteGloveIntake: boom"
    );
  });

  it("revokeWhiteGloveIntake flips only SENT rows and reports whether one flipped", async () => {
    const db = mockDb({
      select: vi.fn().mockResolvedValue({ data: [{ id: INTAKE.id }], error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await revokeWhiteGloveIntake(INTAKE.id)).toBe(true);
    expect(db.update).toHaveBeenCalledWith({ status: "revoked" });
    expect(db.eq).toHaveBeenCalledWith("status", "sent");

    for (const data of [[], null]) {
      const none = mockDb({ select: vi.fn().mockResolvedValue({ data, error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(none as never);
      expect(await revokeWhiteGloveIntake(INTAKE.id)).toBe(false);
    }
  });

  it("revokeWhiteGloveIntake throws on error", async () => {
    const db = mockDb({
      select: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(revokeWhiteGloveIntake(INTAKE.id)).rejects.toThrow(
      "revokeWhiteGloveIntake: boom"
    );
  });

  it("claimWhiteGloveIntakeForBusiness claims atomically with an apply lease", async () => {
    const db = mockDb({
      select: vi.fn().mockResolvedValue({ data: [{ id: INTAKE.id }], error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await claimWhiteGloveIntakeForBusiness(INTAKE.id, "biz-1")).toBe(true);
    expect(db.update).toHaveBeenCalledWith({
      business_id: "biz-1",
      apply_started_at: expect.any(String)
    });
    expect(db.eq).toHaveBeenCalledWith("status", "completed");
    expect(db.or).toHaveBeenCalledWith("business_id.is.null,business_id.eq.biz-1");
    // The lease guard: refuse while another apply's fresh stamp exists.
    expect(db.or).toHaveBeenCalledWith(
      expect.stringMatching(/^apply_started_at\.is\.null,apply_started_at\.lt\./)
    );

    // Linked to a different tenant, or a fresh lease → the claim loses.
    for (const data of [[], null]) {
      const none = mockDb({ select: vi.fn().mockResolvedValue({ data, error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(none as never);
      expect(await claimWhiteGloveIntakeForBusiness(INTAKE.id, "biz-1")).toBe(false);
    }
  });

  it("claimWhiteGloveIntakeForBusiness throws on error", async () => {
    const db = mockDb({
      select: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(claimWhiteGloveIntakeForBusiness(INTAKE.id, "biz-1")).rejects.toThrow(
      "claimWhiteGloveIntakeForBusiness: boom"
    );
  });

  it("markWhiteGloveIntakeApplied stamps the apply on COMPLETED rows only", async () => {
    // The update chain ends on the second .eq() — resolve the row there.
    const db = mockDb();
    db.eq = vi
      .fn()
      .mockReturnValueOnce(db)
      .mockResolvedValueOnce({ error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await markWhiteGloveIntakeApplied(INTAKE.id, { businessId: "biz-1", flowId: "flow-1" });
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        applied_flow_id: "flow-1",
        applied_at: expect.any(String),
        // Success releases the apply lease.
        apply_started_at: null
      })
    );
    expect(db.eq).toHaveBeenCalledWith("id", INTAKE.id);
    expect(db.eq).toHaveBeenCalledWith("status", "completed");
  });

  it("markWhiteGloveIntakeApplied throws on error", async () => {
    const db = mockDb();
    db.eq = vi
      .fn()
      .mockReturnValueOnce(db)
      .mockResolvedValueOnce({ error: { message: "boom" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(
      markWhiteGloveIntakeApplied(INTAKE.id, { businessId: "biz-1", flowId: "flow-1" })
    ).rejects.toThrow("markWhiteGloveIntakeApplied: boom");
  });

  it("whiteGloveIntakeUrl builds the public link from the app URL (set and unset)", () => {
    const saved = process.env.NEXT_PUBLIC_APP_URL;
    try {
      process.env.NEXT_PUBLIC_APP_URL = "https://www.newcoworker.com/";
      expect(whiteGloveIntakeUrl({ token: "tok-abc" })).toBe(
        "https://www.newcoworker.com/intake/tok-abc"
      );
      delete process.env.NEXT_PUBLIC_APP_URL;
      expect(whiteGloveIntakeUrl({ token: "tok-abc" })).toBe(
        "http://localhost:3000/intake/tok-abc"
      );
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = saved;
    }
  });
});
