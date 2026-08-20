/**
 * The Deno side of broadcast booking claims
 * (supabase/functions/_shared/booking_claims.ts): the live-offer predicate
 * shape, and the two-write claim (offer-row compare-and-swap settles the
 * race, then the booking's assignee is stamped only while still unheld).
 * Mirrors the posture pins of unowned_lead_alerts.
 */
import { describe, expect, it, vi } from "vitest";

import {
  claimBookingOffer,
  findLiveBookingClaimsFor
} from "../supabase/functions/_shared/booking_claims";

const BIZ = "11111111-1111-4111-8111-111111111111";
const DAVE = "+14165550991";

type Scripted = { data?: unknown; error?: unknown; throws?: boolean };

/** Chainable fake: one scripted result per terminal await, in call order. */
function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  let idx = 0;
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "update", "eq", "is", "gt", "contains", "order", "limit", "maybeSingle"]) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args });
        return chain;
      };
    }
    chain["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const r = results[idx++] ?? { data: null, error: null };
      if (r.throws) return Promise.reject(new Error("boom")).catch(reject ?? (() => {}));
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(resolve);
    };
    return chain;
  });
  return { db: { from } as never, calls };
}

const offerRow = (over: Record<string, unknown> = {}) => ({
  id: "offer-1",
  dedupe_claim_id: "dedupe-1",
  event_summary: "Strategy call",
  start_local: "Monday at 9:00 AM",
  attendee_name: "Pat Visitor",
  recipients: [DAVE],
  claimed_at: null,
  expires_at: "2026-01-06T00:00:00Z",
  ...over
});

describe("findLiveBookingClaimsFor", () => {
  it("maps live rows and trims blank snapshot fields to null", async () => {
    const { db, calls } = makeDb([
      { data: [offerRow({ event_summary: "  ", start_local: null })] }
    ]);
    const out = await findLiveBookingClaimsFor(db, BIZ, DAVE, "2026-01-05T00:00:00Z");
    expect(out).toEqual([
      {
        offerId: "offer-1",
        dedupeClaimId: "dedupe-1",
        summary: null,
        startLocal: null,
        attendeeName: "Pat Visitor"
      }
    ]);
    // The reader's exact predicate: unclaimed, unexpired, addressed to the
    // sender, newest first.
    expect(calls.some((c) => c.method === "is" && c.args[0] === "claimed_at")).toBe(true);
    expect(calls.some((c) => c.method === "contains" && String(c.args[1]) === DAVE)).toBe(true);
    expect(calls.some((c) => c.method === "gt" && c.args[0] === "expires_at")).toBe(true);
  });

  it("answers [] on a read error, null data, or a throw", async () => {
    expect(
      await findLiveBookingClaimsFor(makeDb([{ error: { message: "boom" } }]).db, BIZ, DAVE, "t")
    ).toEqual([]);
    expect(await findLiveBookingClaimsFor(makeDb([{ data: null }]).db, BIZ, DAVE, "t")).toEqual([]);
    expect(await findLiveBookingClaimsFor(makeDb([{ throws: true }]).db, BIZ, DAVE, "t")).toEqual(
      []
    );
  });
});

describe("claimBookingOffer", () => {
  const args = {
    businessId: BIZ,
    offerId: "offer-1",
    memberId: "m-1",
    claimedByE164: DAVE,
    nowIso: "2026-01-05T12:00:00Z"
  };

  it("wins the race, stamps the booking behind a null guard, and reports the snapshot", async () => {
    const { db, calls } = makeDb([
      { data: [offerRow()] }, // offer CAS matched
      { data: null } // dedupe stamp
    ]);
    const out = await claimBookingOffer(db, args);
    expect(out).toEqual({
      ok: true,
      summary: "Strategy call",
      startLocal: "Monday at 9:00 AM",
      attendeeName: "Pat Visitor",
      recipients: [DAVE]
    });
    const dedupe = calls.filter((c) => c.table === "calendar_booking_dedupe");
    expect(dedupe.some((c) => c.method === "update")).toBe(true);
    // The stamp must be guarded on "still unheld".
    expect(dedupe.some((c) => c.method === "is" && c.args[0] === "assignee_member_id")).toBe(true);
  });

  it("a claimer with no roster row wins the offer but stamps nothing", async () => {
    const { db, calls } = makeDb([{ data: [offerRow()] }]);
    const out = await claimBookingOffer(db, { ...args, memberId: null });
    expect(out.ok).toBe(true);
    expect(calls.some((c) => c.table === "calendar_booking_dedupe")).toBe(false);
  });

  it("a failed or throwing stamp never takes back the won claim", async () => {
    const errored = await claimBookingOffer(
      makeDb([{ data: [offerRow()] }, { error: { message: "denied" } }]).db,
      args
    );
    expect(errored.ok).toBe(true);
    const threw = await claimBookingOffer(
      makeDb([{ data: [offerRow()] }, { throws: true }]).db,
      args
    );
    expect(threw.ok).toBe(true);
  });

  it("null recipients read as an empty stand-down list", async () => {
    const out = await claimBookingOffer(
      makeDb([{ data: [offerRow({ recipients: null })] }, { data: null }]).db,
      args
    );
    expect(out).toMatchObject({ ok: true, recipients: [] });
  });

  it("losing the race re-reads to say WHO won", async () => {
    const out = await claimBookingOffer(
      makeDb([
        { data: [] }, // CAS matched zero rows
        { data: { claimed_by_e164: "+14165550992", claimed_at: "2026-01-05T11:59:00Z" } }
      ]).db,
      args
    );
    expect(out).toEqual({ ok: false, reason: "already_claimed", by: "+14165550992" });
  });

  it("an expired or vanished offer reads as gone", async () => {
    expect(
      await claimBookingOffer(makeDb([{ data: [] }, { data: null }]).db, args)
    ).toEqual({ ok: false, reason: "gone" });
    // A claimed row with no phone on file still names the outcome.
    expect(
      await claimBookingOffer(
        makeDb([{ data: [] }, { data: { claimed_at: "t", claimed_by_e164: null } }]).db,
        args
      )
    ).toEqual({ ok: false, reason: "already_claimed", by: null });
  });

  it("an update error answers gone rather than guessing", async () => {
    expect(await claimBookingOffer(makeDb([{ error: { message: "boom" } }]).db, args)).toEqual({
      ok: false,
      reason: "gone"
    });
  });
});

describe("snapshotless rows", () => {
  it("the finder nulls every blank snapshot field arm", async () => {
    const out = await findLiveBookingClaimsFor(
      makeDb([
        { data: [offerRow({ event_summary: null, start_local: "9:00 AM", attendee_name: null })] }
      ]).db,
      BIZ,
      DAVE,
      "t"
    );
    expect(out[0]).toMatchObject({ summary: null, startLocal: "9:00 AM", attendeeName: null });
  });

  it("a won claim with a null snapshot still answers cleanly", async () => {
    const out = await claimBookingOffer(
      makeDb([
        { data: [offerRow({ event_summary: null, start_local: null, attendee_name: null, recipients: [DAVE] })] },
        { data: null }
      ]).db,
      { businessId: BIZ, offerId: "offer-1", memberId: "m-1", claimedByE164: DAVE, nowIso: "t" }
    );
    expect(out).toMatchObject({ ok: true, summary: null, startLocal: null, attendeeName: null });
  });

  it("a null-data CAS result reads as zero rows, not a win", async () => {
    const out = await claimBookingOffer(
      makeDb([{ data: null }, { data: null }]).db,
      { businessId: BIZ, offerId: "offer-1", memberId: "m-1", claimedByE164: DAVE, nowIso: "t" }
    );
    expect(out).toEqual({ ok: false, reason: "gone" });
  });
});
