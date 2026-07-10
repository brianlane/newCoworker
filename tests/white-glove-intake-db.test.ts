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
    order: vi.fn().mockResolvedValue({ data: [], error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides
  };
}

const INTAKE = {
  id: "0f0f0f0f-0000-4000-8000-000000000001",
  token: "0f0f0f0f-0000-4000-8000-0000000000aa",
  recipient_email: "prospect@example.com",
  business_id: null,
  answers: null,
  status: "sent",
  created_by: "admin@test.com",
  created_at: "2026-07-01T00:00:00Z",
  completed_at: null
};

const ANSWERS = { business_name: "Acme" } as unknown as IntakeAnswers;

describe("white-glove/intake DB layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createWhiteGloveIntake inserts and returns the row (prospect + business-tied)", async () => {
    const db = mockDb({ single: vi.fn().mockResolvedValue({ data: INTAKE, error: null }) });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const row = await createWhiteGloveIntake({
      recipientEmail: INTAKE.recipient_email,
      createdBy: INTAKE.created_by
    });
    expect(row).toEqual(INTAKE);
    expect(db.insert).toHaveBeenCalledWith({
      recipient_email: INTAKE.recipient_email,
      business_id: null,
      created_by: INTAKE.created_by
    });

    await createWhiteGloveIntake({
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
      createWhiteGloveIntake({ recipientEmail: "p@x.com", createdBy: "a@b.c" })
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
