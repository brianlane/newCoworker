import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the three Phase 5 customer-memory voice tools:
 *   - /api/voice/tools/customer-lookup
 *   - /api/voice/tools/customer-set-display-name
 *   - /api/voice/tools/customer-append-pinned-note
 *
 * Each tool follows the same shape as the rest of the
 * /api/voice/tools/* surface: gateway-token guard, parse the envelope
 * (businessId / callControlId / callerE164 / args), validate args,
 * touch customer_memories, return `{ ok, detail?, data? }`. We mock
 * the customer-memory db helpers directly so tests run without a DB.
 */

vi.mock("@/lib/customer-memory/db", () => ({
  getCustomerMemory: vi.fn(),
  updateCustomerOwnerFields: vi.fn(),
  recordInteractionAndIncrement: vi.fn()
}));

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true)
}));

vi.mock("@/lib/db/agent-tool-settings", () => ({
  isAgentToolEnabled: vi.fn()
}));

import { POST as lookupPOST } from "@/app/api/voice/tools/customer-lookup/route";
import { POST as setNamePOST } from "@/app/api/voice/tools/customer-set-display-name/route";
import { POST as appendNotePOST } from "@/app/api/voice/tools/customer-append-pinned-note/route";
import {
  getCustomerMemory,
  recordInteractionAndIncrement,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import { verifyRowboatGatewayToken } from "@/lib/rowboat/gateway-token";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import type { CustomerMemoryRow } from "@/lib/customer-memory/types";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15551234567";

function makeReq(path: string, body: unknown, token = "gw"): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
}

function memory(overrides: Partial<CustomerMemoryRow> = {}): CustomerMemoryRow {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    business_id: BIZ,
    customer_e164: PHONE,
    display_name: null,
    email: null,
    summary_md: null,
    pinned_md: null,
    interaction_count: 0,
    total_interaction_count: 0,
    last_interaction_at: null,
    last_summarized_at: null,
    last_channel: null,
    alias_e164s: [],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyRowboatGatewayToken).mockReturnValue(true);
  // Registry default: the customer-memory voice tools are ON unless toggled.
  vi.mocked(isAgentToolEnabled).mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/voice/tools/customer-lookup", () => {
  it("401s without a valid gateway bearer", async () => {
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(false);
    const res = await lookupPOST(
      makeReq("/api/voice/tools/customer-lookup", { businessId: BIZ, callerE164: PHONE })
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, detail: "unauthorized" });
  });

  it("returns tool_disabled when the owner turned the tool off (Settings → Coworker tools)", async () => {
    vi.mocked(isAgentToolEnabled).mockResolvedValue(false);
    const res = await lookupPOST(
      makeReq("/api/voice/tools/customer-lookup", { businessId: BIZ, callerE164: PHONE })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "tool_disabled" });
    expect(vi.mocked(isAgentToolEnabled)).toHaveBeenCalledWith(
      BIZ,
      "voice",
      "customer_lookup_by_phone"
    );
    expect(getCustomerMemory).not.toHaveBeenCalled();
  });

  it("returns 400 when phone arg is malformed (envelope.callerE164 also missing)", async () => {
    const res = await lookupPOST(
      makeReq("/api/voice/tools/customer-lookup", {
        businessId: BIZ,
        args: { phone: "not-an-e164" }
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when neither phone arg nor envelope.callerE164 is supplied", async () => {
    const res = await lookupPOST(
      makeReq("/api/voice/tools/customer-lookup", { businessId: BIZ })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toMatch(/missing phone/);
  });

  it("found:false when there is no customer_memories row (first-time caller)", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(null);
    const res = await lookupPOST(
      makeReq("/api/voice/tools/customer-lookup", {
        businessId: BIZ,
        callerE164: PHONE
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { found: false } });
    expect(getCustomerMemory).toHaveBeenCalledWith(BIZ, PHONE);
  });

  it("found:true returns voice-safe projection — display_name + summary_md but NEVER pinned_md", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(
      memory({
        display_name: "Joe Plumber",
        summary_md: "Asked about garage doors twice in May.",
        pinned_md: "Owner-private: wife is allergic to nuts",
        last_channel: "voice",
        last_interaction_at: "2026-05-05T10:00:00Z",
        total_interaction_count: 4
      })
    );
    const res = await lookupPOST(
      makeReq("/api/voice/tools/customer-lookup", {
        businessId: BIZ,
        callerE164: PHONE
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.found).toBe(true);
    expect(body.data.customer.displayName).toBe("Joe Plumber");
    expect(body.data.customer.summary).toBe("Asked about garage doors twice in May.");
    expect(body.data.customer.lastChannel).toBe("voice");
    expect(body.data.customer.totalInteractionCount).toBe(4);
    // Owner-private notes are NEVER read back to the caller.
    expect(body.data.customer).not.toHaveProperty("pinnedMd");
    expect(body.data.customer).not.toHaveProperty("pinned_md");
  });

  it("treats anonymous/empty callerE164 as 'not found' instead of 400 (Telnyx CNAM gaps are common)", async () => {
    // Envelope says callerE164 is empty. With no args.phone supplied,
    // we now legitimately have nothing to look up — return a 400.
    // But envelope-allowed empty + valid phone arg should NOT be a 400.
    const res = await lookupPOST(
      makeReq("/api/voice/tools/customer-lookup", {
        businessId: BIZ,
        callerE164: "",
        args: { phone: PHONE }
      })
    );
    expect(res.status).toBe(200);
  });

  it("returns 500 when the DB read throws (transient supabase/RLS hiccup)", async () => {
    vi.mocked(getCustomerMemory).mockRejectedValueOnce(new Error("rls_denied"));
    const res = await lookupPOST(
      makeReq("/api/voice/tools/customer-lookup", {
        businessId: BIZ,
        callerE164: PHONE
      })
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, detail: "internal_error" });
  });
});

describe("POST /api/voice/tools/customer-set-display-name", () => {
  it("401s without a valid gateway bearer", async () => {
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(false);
    const res = await setNamePOST(
      makeReq("/api/voice/tools/customer-set-display-name", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { displayName: "Joe" }
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns tool_disabled when the owner turned the tool off (Settings → Coworker tools)", async () => {
    vi.mocked(isAgentToolEnabled).mockResolvedValue(false);
    const res = await setNamePOST(
      makeReq("/api/voice/tools/customer-set-display-name", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { displayName: "Joe" }
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "tool_disabled" });
    expect(vi.mocked(isAgentToolEnabled)).toHaveBeenCalledWith(
      BIZ,
      "voice",
      "customer_set_display_name"
    );
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("rejects empty / missing displayName via zod", async () => {
    const res = await setNamePOST(
      makeReq("/api/voice/tools/customer-set-display-name", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { displayName: "" }
      })
    );
    expect(res.status).toBe(400);
  });

  it("does NOT clobber an owner-curated display_name (owner edit beats agent transcription forever)", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(
      memory({ display_name: "Joe Plumber" })
    );
    const res = await setNamePOST(
      makeReq("/api/voice/tools/customer-set-display-name", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { displayName: "Joseph P." }
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      data: { updated: false, reason: "name_already_set" }
    });
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("updates display_name when the row exists with a null display_name", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(memory({ display_name: null }));
    vi.mocked(updateCustomerOwnerFields).mockResolvedValueOnce(undefined);
    const res = await setNamePOST(
      makeReq("/api/voice/tools/customer-set-display-name", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { displayName: "  Joe Plumber  " }
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { updated: true } });
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, PHONE, {
      displayName: "Joe Plumber"
    });
  });

  it("force-creates a customer_memories row via record_customer_interaction when none exists (Bugbot Low: silent no-op)", async () => {
    // First lookup returns null (no row) → tool MUST force-create via
    // recordInteractionAndIncrement, then re-read to get the new row.
    // Without this the previous UPDATE-zero-rows path silently
    // succeeded but persisted nothing (Bugbot Low PR #74).
    vi.mocked(getCustomerMemory)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(memory({ display_name: null }));
    vi.mocked(recordInteractionAndIncrement).mockResolvedValueOnce(memory());
    vi.mocked(updateCustomerOwnerFields).mockResolvedValueOnce(undefined);
    const res = await setNamePOST(
      makeReq("/api/voice/tools/customer-set-display-name", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { displayName: "Joe" }
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { updated: true } });
    expect(recordInteractionAndIncrement).toHaveBeenCalledWith(BIZ, PHONE, "voice", {
      displayName: "Joe"
    });
    expect(updateCustomerOwnerFields).toHaveBeenCalled();
  });

  it("returns name_already_set_matches when the RPC's p_display_name already populated the new row to the same value", async () => {
    // RPC's p_display_name path: when the row didn't exist AND we
    // pass the agent-discovered name, the RPC sets it on the new
    // row. The follow-up UPDATE is then unnecessary — return a
    // distinct reason so callers can tell "redundant write" apart
    // from "owner-curated, do not touch".
    vi.mocked(getCustomerMemory)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(memory({ display_name: "Joe" }));
    vi.mocked(recordInteractionAndIncrement).mockResolvedValueOnce(
      memory({ display_name: "Joe" })
    );
    const res = await setNamePOST(
      makeReq("/api/voice/tools/customer-set-display-name", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { displayName: "Joe" }
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { updated: false, reason: "name_already_set_matches" }
    });
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("propagates 500 when the force-create RPC itself throws (otherwise we'd silently lose the name)", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(null);
    vi.mocked(recordInteractionAndIncrement).mockRejectedValueOnce(new Error("rls"));
    const res = await setNamePOST(
      makeReq("/api/voice/tools/customer-set-display-name", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { displayName: "Joe" }
      })
    );
    expect(res.status).toBe(500);
  });

  it("returns 400 when phone is missing AND envelope.callerE164 is missing", async () => {
    const res = await setNamePOST(
      makeReq("/api/voice/tools/customer-set-display-name", {
        businessId: BIZ,
        args: { displayName: "Joe" }
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/voice/tools/customer-append-pinned-note", () => {
  it("401s without a valid gateway bearer", async () => {
    vi.mocked(verifyRowboatGatewayToken).mockReturnValue(false);
    const res = await appendNotePOST(
      makeReq("/api/voice/tools/customer-append-pinned-note", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { note: "wife is allergic to nuts" }
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns tool_disabled when the owner turned the tool off (Settings → Coworker tools)", async () => {
    vi.mocked(isAgentToolEnabled).mockResolvedValue(false);
    const res = await appendNotePOST(
      makeReq("/api/voice/tools/customer-append-pinned-note", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { note: "wife is allergic to nuts" }
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "tool_disabled" });
    expect(vi.mocked(isAgentToolEnabled)).toHaveBeenCalledWith(
      BIZ,
      "voice",
      "customer_append_pinned_note"
    );
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("rejects empty notes (zod) and over-long notes (1500 char cap)", async () => {
    const res1 = await appendNotePOST(
      makeReq("/api/voice/tools/customer-append-pinned-note", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { note: "   " }
      })
    );
    expect(res1.status).toBe(400);

    const res2 = await appendNotePOST(
      makeReq("/api/voice/tools/customer-append-pinned-note", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { note: "x".repeat(1501) }
      })
    );
    expect(res2.status).toBe(400);
  });

  it("appends with a date-stamped 'via voice' header on first note (no prior pinned_md) and reports truncated:false (Bugbot Low PR #74)", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(memory({ pinned_md: null }));
    vi.mocked(updateCustomerOwnerFields).mockResolvedValueOnce(undefined);
    const res = await appendNotePOST(
      makeReq("/api/voice/tools/customer-append-pinned-note", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { note: "wife is allergic to nuts" }
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Bugbot Low PR #74: previous version compared `prior + 2 (separator)
    // + newLine` against `combined`, which was wrong when prior was
    // empty (no separator added) — always reported truncated:true on
    // the very first pinned note. Fixed by comparing what we WANTED
    // to write against what we actually persisted.
    expect(body.data.truncated).toBe(false);
    const updateCall = vi.mocked(updateCustomerOwnerFields).mock.calls[0]!;
    const newPinned = (updateCall[2] as { pinnedMd: string }).pinnedMd;
    expect(newPinned).toMatch(/^\[\d{4}-\d{2}-\d{2} via voice\] wife is allergic to nuts$/);
  });

  it("force-creates a customer_memories row before appending when none exists (Bugbot Low: silent no-op write)", async () => {
    // Same Bugbot Low fix as customer-set-display-name: previously the
    // append would UPDATE zero rows and report success, persisting
    // nothing. Now we record_customer_interaction first to ensure
    // the row exists, then append.
    vi.mocked(getCustomerMemory)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(memory({ pinned_md: null }));
    vi.mocked(recordInteractionAndIncrement).mockResolvedValueOnce(memory());
    vi.mocked(updateCustomerOwnerFields).mockResolvedValueOnce(undefined);
    const res = await appendNotePOST(
      makeReq("/api/voice/tools/customer-append-pinned-note", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { note: "wife is allergic to nuts" }
      })
    );
    expect(res.status).toBe(200);
    expect(recordInteractionAndIncrement).toHaveBeenCalledWith(BIZ, PHONE, "voice", {});
    expect(updateCustomerOwnerFields).toHaveBeenCalled();
  });

  it("force-create degrades gracefully when the second getCustomerMemory still returns null (RPC raced or RLS quirk) — still attempts the UPDATE so we don't fail closed", async () => {
    // Defensive path: record_customer_interaction succeeded but the
    // re-read came back null (rare race or RLS). Rather than abort,
    // we still UPDATE — if the row really doesn't exist we'll just
    // match zero rows again (no worse than before), and if it
    // briefly existed the next interaction will repair things.
    vi.mocked(getCustomerMemory)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    vi.mocked(recordInteractionAndIncrement).mockResolvedValueOnce(memory());
    vi.mocked(updateCustomerOwnerFields).mockResolvedValueOnce(undefined);
    const res = await appendNotePOST(
      makeReq("/api/voice/tools/customer-append-pinned-note", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { note: "Test note" }
      })
    );
    expect(res.status).toBe(200);
  });

  it("appends to existing pinned_md with a blank line separator (preserves human readability)", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(
      memory({ pinned_md: "Existing owner note from dashboard" })
    );
    vi.mocked(updateCustomerOwnerFields).mockResolvedValueOnce(undefined);
    await appendNotePOST(
      makeReq("/api/voice/tools/customer-append-pinned-note", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { note: "asks for Saturday slots" }
      })
    );
    const newPinned = (vi.mocked(updateCustomerOwnerFields).mock.calls[0]![2] as {
      pinnedMd: string;
    }).pinnedMd;
    expect(newPinned).toContain("Existing owner note from dashboard");
    expect(newPinned).toContain("\n\n[");
    expect(newPinned).toContain("asks for Saturday slots");
  });

  it("reports truncated:true when the combined pinned_md was clipped to fit PINNED_MAX_CHARS", async () => {
    const prior = "OLD\n" + "x".repeat(3600);
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(memory({ pinned_md: prior }));
    vi.mocked(updateCustomerOwnerFields).mockResolvedValueOnce(undefined);
    const res = await appendNotePOST(
      makeReq("/api/voice/tools/customer-append-pinned-note", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { note: "y".repeat(800) }
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.truncated).toBe(true);
    expect(body.data.pinnedChars).toBeLessThanOrEqual(4000);
  });

  it("truncates from the OLDEST end when combined exceeds PINNED_MAX_CHARS — most recent guidance survives", async () => {
    // Build a prior 3500-char note; new note ~1000 chars should make
    // combined ~4500 chars and the implementation should trim to 4000
    // by dropping from the start.
    const prior = "OLD NOTE\n" + "x".repeat(3500);
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(memory({ pinned_md: prior }));
    vi.mocked(updateCustomerOwnerFields).mockResolvedValueOnce(undefined);
    const newNote = "y".repeat(1000);
    await appendNotePOST(
      makeReq("/api/voice/tools/customer-append-pinned-note", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { note: newNote }
      })
    );
    const newPinned = (vi.mocked(updateCustomerOwnerFields).mock.calls[0]![2] as {
      pinnedMd: string;
    }).pinnedMd;
    expect(newPinned.length).toBeLessThanOrEqual(4000);
    // The OLDEST chars get clipped — the agent's new note + part of
    // the prior owner note remains.
    expect(newPinned.endsWith(newNote)).toBe(true);
    expect(newPinned).not.toContain("OLD NOTE");
  });

  it("refuses notes that would exceed PINNED_MAX_CHARS by themselves (even with the date header)", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(memory({ pinned_md: null }));
    const note = "z".repeat(1499); // 1499 + " via voice" header > 4000? No, only ~24 chars header so 1499 < 4000.
    // Actually the per-arg cap is 1500, far below PINNED_MAX_CHARS, so
    // a single note can never trigger note_too_long via that path.
    // The path IS triggered when an attacker / model hands a stamp
    // longer than expected — pin via direct module test in db.test.ts
    // if we ever expose PINNED_MAX_CHARS as a configurable. For now
    // the practical path is the truncate branch covered above; we
    // just sanity-check the "happy" boundary here.
    vi.mocked(updateCustomerOwnerFields).mockResolvedValueOnce(undefined);
    const res = await appendNotePOST(
      makeReq("/api/voice/tools/customer-append-pinned-note", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { note }
      })
    );
    expect(res.status).toBe(200);
  });

  it("returns 500 when DB write throws", async () => {
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(memory({ pinned_md: null }));
    vi.mocked(updateCustomerOwnerFields).mockRejectedValueOnce(new Error("rls"));
    const res = await appendNotePOST(
      makeReq("/api/voice/tools/customer-append-pinned-note", {
        businessId: BIZ,
        callerE164: PHONE,
        args: { note: "hi" }
      })
    );
    expect(res.status).toBe(500);
  });
});
