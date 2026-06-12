import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getNotificationPreferences,
  getOrCreateNotificationPreferences,
  initialNotificationPreferenceContactsFromSeeds,
  mergeNotificationContactsForDisplay,
  isUniqueViolation,
  updateNotificationPreferences
} from "@/lib/db/notification-preferences";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const PREFS = {
  business_id: "biz-1",
  sms_urgent: true,
  email_digest: true,
  email_digest_weekly: true,
  email_urgent: true,
  dashboard_alerts: true,
  phone_number: null,
  alert_email: null,
  unsubscribed_at: null,
  updated_at: "2026-01-01T00:00:00Z"
};

describe("db/notification-preferences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("isUniqueViolation handles null and unique-constraint messages", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation({ message: "duplicate key value violates unique constraint" })).toBe(
      true
    );
  });

  it("initialNotificationPreferenceContactsFromSeeds fills from user and auth phone", () => {
    const c = initialNotificationPreferenceContactsFromSeeds({
      userEmail: "u@example.com",
      authPhone: "+1999",
      ownerEmail: "owner@biz.com",
      businessPhone: "5551112222"
    });
    expect(c.alert_email).toBe("u@example.com");
    expect(c.phone_number).toBe("+1999");
  });

  it("initialNotificationPreferenceContactsFromSeeds skips blank and trims sources", () => {
    expect(
      initialNotificationPreferenceContactsFromSeeds({
        userEmail: null,
        authPhone: null,
        ownerEmail: " fallback@biz.com ",
        businessPhone: " +12225550100 "
      })
    ).toEqual({ alert_email: "fallback@biz.com", phone_number: "+12225550100" });

    expect(
      initialNotificationPreferenceContactsFromSeeds({
        userEmail: null,
        authPhone: null,
        ownerEmail: null,
        businessPhone: null
      })
    ).toEqual({ alert_email: null, phone_number: null });
  });

  it("initialNotificationPreferenceContactsFromSeeds prefers user email before owner", () => {
    const c = initialNotificationPreferenceContactsFromSeeds({
      userEmail: "u@prio.com",
      authPhone: null,
      ownerEmail: "owner@biz.com",
      businessPhone: "5550001111"
    });
    expect(c.alert_email).toBe("u@prio.com");
    expect(c.phone_number).toBe("5550001111");
  });

  it("initialNotificationPreferenceContactsFromSeeds treats blank strings like null", () => {
    expect(
      initialNotificationPreferenceContactsFromSeeds({
        userEmail: " \t ",
        authPhone: "",
        ownerEmail: " owner@biz.com ",
        businessPhone: " \n "
      })
    ).toEqual({ alert_email: "owner@biz.com", phone_number: null });

    expect(
      initialNotificationPreferenceContactsFromSeeds({
        userEmail: "",
        authPhone: " ",
        ownerEmail: "",
        businessPhone: "final-phone "
      })
    ).toEqual({ alert_email: null, phone_number: "final-phone" });
  });
  it("mergeNotificationContactsForDisplay fills null stored fields from account seeds", () => {
    const merged = mergeNotificationContactsForDisplay(
      { alert_email: null, phone_number: null },
      {
        userEmail: "u@example.com",
        authPhone: "+15551112222",
        ownerEmail: "owner@biz.com",
        businessPhone: "+15553334444"
      }
    );
    expect(merged).toEqual({
      alert_email: "u@example.com",
      phone_number: "+15551112222"
    });
  });

  it("mergeNotificationContactsForDisplay keeps a real stored value over seeds", () => {
    const merged = mergeNotificationContactsForDisplay(
      { alert_email: "kept@stored.com", phone_number: "+19998887777" },
      {
        userEmail: "u@example.com",
        authPhone: "+15551112222",
        ownerEmail: "owner@biz.com",
        businessPhone: "+15553334444"
      }
    );
    expect(merged).toEqual({
      alert_email: "kept@stored.com",
      phone_number: "+19998887777"
    });
  });

  it("mergeNotificationContactsForDisplay treats blank stored values as empty and refills", () => {
    const merged = mergeNotificationContactsForDisplay(
      { alert_email: "   ", phone_number: "" },
      {
        userEmail: null,
        authPhone: null,
        ownerEmail: "owner@biz.com",
        businessPhone: "+15553334444"
      }
    );
    expect(merged).toEqual({
      alert_email: "owner@biz.com",
      phone_number: "+15553334444"
    });
  });

  it("getNotificationPreferences returns row", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getNotificationPreferences("biz-1");
    expect(row?.business_id).toBe("biz-1");
  });

  it("getNotificationPreferences returns null when missing", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getNotificationPreferences("biz-1")).resolves.toBeNull();
  });

  it("getNotificationPreferences throws on error", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "e" } })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getNotificationPreferences("biz-1")).rejects.toThrow("getNotificationPreferences");
  });

  it("getOrCreateNotificationPreferences returns existing", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getOrCreateNotificationPreferences("biz-1");
    expect(row.business_id).toBe("biz-1");
  });

  it("getOrCreateNotificationPreferences inserts when missing", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const insertChain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(insertChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getOrCreateNotificationPreferences("biz-1");
    expect(row.business_id).toBe("biz-1");
    expect(insertChain.insert).toHaveBeenCalled();
  });

  it("getOrCreateNotificationPreferences merges contactSeeds only on insert", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const insertChain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(insertChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await getOrCreateNotificationPreferences("biz-1", {
      contactSeeds: {
        userEmail: "dash@biz.com",
        authPhone: "+15550001111",
        ownerEmail: "owner@biz.com",
        businessPhone: "Ignored when authPhone set"
      }
    });

    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        alert_email: "dash@biz.com",
        phone_number: "+15550001111"
      })
    );
  });

  it("getOrCreateNotificationPreferences inserts defaults when opts has client but no contactSeeds", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const insertChain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const shared = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(insertChain)
    };

    await getOrCreateNotificationPreferences("biz-1", { client: shared as never });

    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        alert_email: null,
        phone_number: null
      })
    );
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("getOrCreateNotificationPreferences ignores contactSeeds when row exists", async () => {
    const seeded = {
      ...PREFS,
      alert_email: "already@saved.com",
      phone_number: null
    };
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: seeded, error: null }),
      insert: vi.fn().mockImplementation(() => {
        throw new Error("unexpected insert");
      })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getOrCreateNotificationPreferences("biz-1", {
      contactSeeds: {
        userEmail: "different@fresh.com",
        authPhone: null,
        ownerEmail: null,
        businessPhone: null
      }
    });
    expect(row.alert_email).toBe("already@saved.com");
  });

  it("getOrCreateNotificationPreferences throws on insert error", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const insertChain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: "dup" } })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(insertChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getOrCreateNotificationPreferences("biz-1")).rejects.toThrow(
      "getOrCreateNotificationPreferences"
    );
  });

  it("getOrCreateNotificationPreferences returns existing row after insert conflict", async () => {
    const selectMissingChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValueOnce({ data: null, error: null })
    };
    const insertChain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "23505", message: "duplicate key value violates unique constraint" }
      })
    };
    const selectExistingChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValueOnce({ data: PREFS, error: null })
    };
    const db = {
      from: vi
        .fn()
        .mockReturnValueOnce(selectMissingChain)
        .mockReturnValueOnce(insertChain)
        .mockReturnValueOnce(selectExistingChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getOrCreateNotificationPreferences("biz-1")).resolves.toEqual(PREFS);
  });

  it("getOrCreateNotificationPreferences throws when insert conflict retry still finds no row", async () => {
    const selectMissingChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValueOnce({ data: null, error: null })
    };
    const insertChain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "23505", message: "duplicate key value violates unique constraint" }
      })
    };
    const selectMissingAgainChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValueOnce({ data: null, error: null })
    };
    const db = {
      from: vi
        .fn()
        .mockReturnValueOnce(selectMissingChain)
        .mockReturnValueOnce(insertChain)
        .mockReturnValueOnce(selectMissingAgainChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getOrCreateNotificationPreferences("biz-1")).rejects.toThrow(
      "getOrCreateNotificationPreferences"
    );
  });

  it("updateNotificationPreferences updates", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { ...PREFS, sms_urgent: false },
        error: null
      })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await updateNotificationPreferences("biz-1", { sms_urgent: false });
    expect(row.sms_urgent).toBe(false);
    expect(updateChain.update).toHaveBeenCalled();
  });

  it("updateNotificationPreferences can set sms_urgent to true", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { ...PREFS, sms_urgent: false }, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { ...PREFS, sms_urgent: true },
        error: null
      })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await updateNotificationPreferences("biz-1", { sms_urgent: true });
    expect(row.sms_urgent).toBe(true);
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ sms_urgent: true })
    );
  });

  it("updateNotificationPreferences omits unchanged fields from patch", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { ...PREFS, email_digest: false },
        error: null
      })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await updateNotificationPreferences("biz-1", { email_digest: false });
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        email_digest: false,
        updated_at: expect.any(String)
      })
    );
    const payload = updateChain.update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("sms_urgent");
  });

  it("updateNotificationPreferences applies all patch fields with shared client", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          ...PREFS,
          phone_number: "+1",
          alert_email: "a@b.com",
          email_digest: false
        },
        error: null
      })
    };
    const shared = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };

    const row = await updateNotificationPreferences(
      "biz-1",
      {
        sms_urgent: false,
        email_urgent: true,
        dashboard_alerts: false,
        phone_number: "+1",
        alert_email: "a@b.com",
        email_digest: false
      },
      shared as never
    );
    expect(row.phone_number).toBe("+1");
    expect(row.alert_email).toBe("a@b.com");
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        sms_urgent: false,
        email_urgent: true,
        dashboard_alerts: false,
        phone_number: "+1",
        alert_email: "a@b.com",
        email_digest: false
      })
    );
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("updateNotificationPreferences throws on update error", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: "fail" } })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(updateNotificationPreferences("biz-1", { sms_urgent: false })).rejects.toThrow(
      "updateNotificationPreferences"
    );
  });

  it("getNotificationPreferences uses injected client", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const db = { from: vi.fn().mockReturnValue(chain) };
    await getNotificationPreferences("biz-1", db as never);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("updateNotificationPreferences accepts unsubscribed_at", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { ...PREFS, unsubscribed_at: "2026-05-01T00:00:00Z", sms_urgent: false },
        error: null
      })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const row = await updateNotificationPreferences("biz-1", {
      sms_urgent: false,
      unsubscribed_at: "2026-05-01T00:00:00Z"
    });
    expect(row.unsubscribed_at).toBe("2026-05-01T00:00:00Z");
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ unsubscribed_at: "2026-05-01T00:00:00Z" })
    );
  });

  it("updateNotificationPreferences clears unsubscribed_at when re-enabling any toggle", async () => {
    const startingPrefs = { ...PREFS, unsubscribed_at: "2026-05-01T00:00:00Z" };
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: startingPrefs, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { ...startingPrefs, email_urgent: true, unsubscribed_at: null },
        error: null
      })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await updateNotificationPreferences("biz-1", { email_urgent: true });
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ email_urgent: true, unsubscribed_at: null })
    );
  });

  it("updateNotificationPreferences clears unsubscribed_at when re-enabling the weekly digest", async () => {
    const startingPrefs = {
      ...PREFS,
      email_digest_weekly: false,
      unsubscribed_at: "2026-05-01T00:00:00Z"
    };
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: startingPrefs, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { ...startingPrefs, email_digest_weekly: true, unsubscribed_at: null },
        error: null
      })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await updateNotificationPreferences("biz-1", { email_digest_weekly: true });
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ email_digest_weekly: true, unsubscribed_at: null })
    );
  });

  it("updateNotificationPreferences does not auto-clear unsubscribed_at when only setting toggles to false", async () => {
    const startingPrefs = { ...PREFS, unsubscribed_at: "2026-05-01T00:00:00Z" };
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: startingPrefs, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: startingPrefs, error: null })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await updateNotificationPreferences("biz-1", { sms_urgent: false });
    const payload = updateChain.update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("unsubscribed_at");
  });

  it("updateNotificationPreferences respects explicit unsubscribed_at over auto-clear", async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: PREFS, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { ...PREFS, sms_urgent: true, unsubscribed_at: "2026-05-01T00:00:00Z" },
        error: null
      })
    };
    const db = {
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await updateNotificationPreferences("biz-1", {
      sms_urgent: true,
      unsubscribed_at: "2026-05-01T00:00:00Z"
    });
    const payload = updateChain.update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.unsubscribed_at).toBe("2026-05-01T00:00:00Z");
  });
});
