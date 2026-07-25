import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  checkSmsOptOut,
  getSmsOptOutKind,
  listSmsOptOuts,
  setSmsOptOut
} from "@/lib/sms/opt-outs";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listSmsOptOuts", () => {
  function listDb(result: { data: unknown; error: { message: string } | null }) {
    return {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue(result)
    };
  }

  it("returns the business's opt-out rows newest-first", async () => {
    const rows = [
      { business_id: BIZ, sender_e164: "+16025550111", kind: "stop", set_at: "s", updated_at: "u" }
    ];
    const db = listDb({ data: rows, error: null });
    const result = await listSmsOptOuts(BIZ, db as never);
    expect(result).toEqual(rows);
    expect(db.from).toHaveBeenCalledWith("sms_opt_outs");
    expect(db.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(db.order).toHaveBeenCalledWith("set_at", { ascending: false });
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("returns [] for a null data payload and throws on errors", async () => {
    const empty = listDb({ data: null, error: null });
    await expect(listSmsOptOuts(BIZ, empty as never)).resolves.toEqual([]);

    const failing = listDb({ data: null, error: { message: "rls" } });
    await expect(listSmsOptOuts(BIZ, failing as never)).rejects.toThrow("listSmsOptOuts: rls");
  });

  it("falls back to the service client when none is provided", async () => {
    const db = listDb({ data: [], error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(listSmsOptOuts(BIZ)).resolves.toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("getSmsOptOutKind", () => {
  function kindDb(result: { data: unknown; error: { message: string } | null }) {
    return {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue(result)
    };
  }

  it("returns the row's kind, and null when the number is not suppressed", async () => {
    expect(
      await getSmsOptOutKind(BIZ, "+16025550111", kindDb({ data: { kind: "owner_spam" }, error: null }) as never)
    ).toBe("owner_spam");
    expect(
      await getSmsOptOutKind(BIZ, "+16025550111", kindDb({ data: { kind: "stop" }, error: null }) as never)
    ).toBe("stop");
    expect(
      await getSmsOptOutKind(BIZ, "+16025550111", kindDb({ data: null, error: null }) as never)
    ).toBeNull();
    // An unknown provenance value degrades to "not suppressed" rather than
    // guessing at semantics.
    expect(
      await getSmsOptOutKind(BIZ, "+16025550111", kindDb({ data: { kind: "???" }, error: null }) as never)
    ).toBeNull();
  });

  it("treats read errors as not suppressed (warn-logged), unlike SMS consent", async () => {
    expect(
      await getSmsOptOutKind(BIZ, "+16025550111", kindDb({ data: null, error: { message: "rls" } }) as never)
    ).toBeNull();

    // Non-Error rejection shapes too (PG drivers can surface plain strings).
    const throwing = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockRejectedValue("socket boom")
    };
    expect(await getSmsOptOutKind(BIZ, "+16025550111", throwing as never)).toBeNull();
  });

  it("falls back to the service client when none is provided", async () => {
    const db = kindDb({ data: { kind: "stop" }, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await getSmsOptOutKind(BIZ, "+16025550111")).toBe("stop");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("checkSmsOptOut", () => {
  it("returns optedOut true/false from the RPC", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) };
    await expect(checkSmsOptOut(BIZ, "+16025550111", db as never)).resolves.toEqual({
      ok: true,
      optedOut: true
    });
    expect(db.rpc).toHaveBeenCalledWith("sms_is_opted_out", {
      p_business_id: BIZ,
      p_sender_e164: "+16025550111"
    });

    const dbFalse = { rpc: vi.fn().mockResolvedValue({ data: false, error: null }) };
    await expect(checkSmsOptOut(BIZ, "+16025550111", dbFalse as never)).resolves.toEqual({
      ok: true,
      optedOut: false
    });
  });

  it("returns a typed failure (never throws) so send sites can fail closed", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "db down" } }) };
    await expect(checkSmsOptOut(BIZ, "+16025550111", db as never)).resolves.toEqual({
      ok: false,
      error: "db down"
    });
  });

  it("falls back to the service client when none is provided", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: false, error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(checkSmsOptOut(BIZ, "+16025550111")).resolves.toEqual({
      ok: true,
      optedOut: false
    });
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("setSmsOptOut", () => {
  it("returns isNew from the RPC payload", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: { ok: true, new: true }, error: null }) };
    await expect(setSmsOptOut(BIZ, "+16025550111", db as never)).resolves.toEqual({ isNew: true });
    // Defaults to the sacred customer-STOP kind when the caller doesn't say.
    expect(db.rpc).toHaveBeenCalledWith("sms_set_opt_out", {
      p_business_id: BIZ,
      p_sender_e164: "+16025550111",
      p_kind: "stop"
    });

    const dbExisting = {
      rpc: vi.fn().mockResolvedValue({ data: { ok: true, new: false }, error: null })
    };
    await expect(setSmsOptOut(BIZ, "+16025550111", dbExisting as never)).resolves.toEqual({
      isNew: false
    });
  });

  it("passes an owner-initiated kind through to the RPC (provenance, Chris Gregoris incident)", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: { ok: true, new: true }, error: null }) };
    await setSmsOptOut(BIZ, "+16025550111", db as never, "owner_spam");
    expect(db.rpc).toHaveBeenCalledWith("sms_set_opt_out", {
      p_business_id: BIZ,
      p_sender_e164: "+16025550111",
      p_kind: "owner_spam"
    });
  });

  it("throws on RPC transport errors and on non-ok payloads", async () => {
    const dbErr = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) };
    await expect(setSmsOptOut(BIZ, "+1", dbErr as never)).rejects.toThrow("setSmsOptOut: boom");

    const dbRefused = {
      rpc: vi.fn().mockResolvedValue({ data: { ok: false, reason: "missing_sender" }, error: null })
    };
    await expect(setSmsOptOut(BIZ, "", dbRefused as never)).rejects.toThrow(
      "setSmsOptOut: missing_sender"
    );

    const dbNullData = { rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
    await expect(setSmsOptOut(BIZ, "+1", dbNullData as never)).rejects.toThrow(
      "setSmsOptOut: rpc_failed"
    );
  });

  it("falls back to the service client when none is provided", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: { ok: true, new: true }, error: null }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(setSmsOptOut(BIZ, "+16025550111")).resolves.toEqual({ isNew: true });
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});
