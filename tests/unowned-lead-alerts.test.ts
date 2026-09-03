import { describe, expect, it, vi } from "vitest";
import {
  ALERT_CLAIM_WINDOW_MS,
  claimUnownedLeadAlert,
  findLiveUnownedAlertsFor,
  recordUnownedLeadAlert
} from "../supabase/functions/_shared/unowned_lead_alerts";

/**
 * Claimable unowned-lead alerts.
 *
 * The claim machinery understands one thing: a parked route_to_team run. A
 * teammate who replied "1" to an ALERT had it resolve against an unrelated
 * older offer, because the alert had no run to attach to. This is the record
 * that fixes it, and every test here is about one property: a claim is a
 * compare-and-swap, so two teammates racing cannot both win.
 */

const BIZ = "11111111-1111-4111-8111-111111111111";
const DAVE = "+16025245719";
const GABBY = "+14807202013";
const LEAD = "+15138500200";
const NOW = Date.parse("2026-08-15T18:00:00.000Z");

/** Chainable fake: every builder method returns itself; `then` resolves. */
function makeDb(script: Array<{ data?: unknown; error?: unknown; throws?: boolean }>) {
  const calls: Array<{ table: string; op: string; payload?: unknown }> = [];
  let i = 0;
  const from = (table: string) => {
    let op = "select";
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "gt", "contains", "order", "limit", "maybeSingle", "or"]) {
      builder[m] = () => builder;
    }
    builder["insert"] = (payload: unknown) => {
      op = "insert";
      calls.push({ table, op, payload });
      return builder;
    };
    builder["update"] = (payload: unknown) => {
      op = "update";
      calls.push({ table, op, payload });
      return builder;
    };
    builder["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const r = script[i++] ?? { data: null, error: null };
      if (r.throws) return Promise.reject(new Error("boom")).catch(reject ?? (() => {}));
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(resolve);
    };
    if (op === "select") calls.push({ table, op });
    return builder;
  };
  return { db: { from }, calls };
}

describe("recordUnownedLeadAlert", () => {
  it("writes the lead, the label, and everyone who was texted", async () => {
    const { db, calls } = makeDb([{ data: { id: "a1" } }]);
    const id = await recordUnownedLeadAlert(db, {
      businessId: BIZ,
      leadE164: LEAD,
      leadLabel: "Richard",
      recipients: [DAVE, GABBY],
      nowMs: NOW
    });
    expect(id).toBe("a1");
    const insert = calls.find((c) => c.op === "insert")!.payload as Record<string, unknown>;
    expect(insert.lead_e164).toBe(LEAD);
    expect(insert.lead_label).toBe("Richard");
    expect(insert.recipients).toEqual([DAVE, GABBY]);
    expect(Date.parse(insert.expires_at as string)).toBe(NOW + ALERT_CLAIM_WINDOW_MS);
  });

  it("records nothing when there is no lead to claim", async () => {
    // A business-level alert (billing, plan) names no contact. Normal, not an
    // error: there is simply nothing for a "1" to take.
    for (const lead of [null, undefined, "", "   "]) {
      const { db, calls } = makeDb([]);
      expect(await recordUnownedLeadAlert(db, {
        businessId: BIZ,
        leadE164: lead,
        recipients: [DAVE],
        nowMs: NOW
      })).toBeNull();
      expect(calls).toEqual([]);
    }
  });

  it("records nothing when nobody could claim it", async () => {
    const { db, calls } = makeDb([]);
    expect(await recordUnownedLeadAlert(db, {
      businessId: BIZ,
      leadE164: LEAD,
      recipients: ["", "   "],
      nowMs: NOW
    })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("normalizes a blank label to null and trims recipients", async () => {
    const { db, calls } = makeDb([{ data: { id: "a1" } }]);
    await recordUnownedLeadAlert(db, {
      businessId: BIZ,
      leadE164: `  ${LEAD} `,
      leadLabel: "   ",
      recipients: [` ${DAVE} `, ""],
      nowMs: NOW
    });
    const insert = calls.find((c) => c.op === "insert")!.payload as Record<string, unknown>;
    expect(insert.lead_e164).toBe(LEAD);
    expect(insert.lead_label).toBeNull();
    expect(insert.recipients).toEqual([DAVE]);
  });

  it("honors an explicit window", async () => {
    const { db, calls } = makeDb([{ data: { id: "a1" } }]);
    await recordUnownedLeadAlert(db, {
      businessId: BIZ,
      leadE164: LEAD,
      recipients: [DAVE],
      nowMs: NOW,
      windowMs: 60_000
    });
    const insert = calls.find((c) => c.op === "insert")!.payload as Record<string, unknown>;
    expect(Date.parse(insert.expires_at as string)).toBe(NOW + 60_000);
  });

  it("never throws: the alert already went out", async () => {
    // Losing the ability to claim by text is strictly better than failing a
    // send that already reached the team.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = makeDb([{ error: { message: "nope" } }]);
    expect(await recordUnownedLeadAlert(failed.db, {
      businessId: BIZ,
      leadE164: LEAD,
      recipients: [DAVE],
      nowMs: NOW
    })).toBeNull();
    const threw = makeDb([{ throws: true }]);
    expect(await recordUnownedLeadAlert(threw.db, {
      businessId: BIZ,
      leadE164: LEAD,
      recipients: [DAVE],
      nowMs: NOW
    })).toBeNull();
    err.mockRestore();
  });

  it("returns null when the insert comes back with no row", async () => {
    const { db } = makeDb([{ data: null }]);
    expect(await recordUnownedLeadAlert(db, {
      businessId: BIZ,
      leadE164: LEAD,
      recipients: [DAVE],
      nowMs: NOW
    })).toBeNull();
  });
});

describe("findLiveUnownedAlertsFor", () => {
  const NOW_ISO = new Date(NOW).toISOString();

  it("returns candidates newest first", async () => {
    const { db } = makeDb([
      {
        data: [
          { id: "a2", lead_e164: LEAD, lead_label: "Richard" },
          { id: "a1", lead_e164: "+15550000000", lead_label: null }
        ]
      }
    ]);
    const out = await findLiveUnownedAlertsFor(db, BIZ, DAVE, NOW_ISO);
    expect(out).toEqual([
      { alertId: "a2", leadE164: LEAD, leadLabel: "Richard" },
      { alertId: "a1", leadE164: "+15550000000", leadLabel: null }
    ]);
  });

  it("collapses two live alerts about the same phone to the newest", async () => {
    const { db } = makeDb([
      {
        data: [
          { id: "new", lead_e164: LEAD, lead_label: "Christopher Ackermann" },
          { id: "old", lead_e164: LEAD, lead_label: "Christopher Ackermann" },
          { id: "other", lead_e164: "+16025703299", lead_label: "Jeffrey Cutler" }
        ]
      }
    ]);
    expect(await findLiveUnownedAlertsFor(db, BIZ, DAVE, NOW_ISO)).toEqual([
      { alertId: "new", leadE164: LEAD, leadLabel: "Christopher Ackermann" },
      { alertId: "other", leadE164: "+16025703299", leadLabel: "Jeffrey Cutler" }
    ]);
  });

  it("normalizes a blank label to null", async () => {
    const { db } = makeDb([{ data: [{ id: "a1", lead_e164: LEAD, lead_label: "   " }] }]);
    expect((await findLiveUnownedAlertsFor(db, BIZ, DAVE, NOW_ISO))[0].leadLabel).toBeNull();
  });

  it("returns nothing rather than throwing when the read fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = makeDb([{ error: { message: "down" } }]);
    expect(await findLiveUnownedAlertsFor(failed.db, BIZ, DAVE, NOW_ISO)).toEqual([]);
    const threw = makeDb([{ throws: true }]);
    expect(await findLiveUnownedAlertsFor(threw.db, BIZ, DAVE, NOW_ISO)).toEqual([]);
    err.mockRestore();
  });

  it("treats a null result as no candidates", async () => {
    const { db } = makeDb([{ data: null }]);
    expect(await findLiveUnownedAlertsFor(db, BIZ, DAVE, NOW_ISO)).toEqual([]);
  });
});

describe("claimUnownedLeadAlert", () => {
  const NOW_ISO = new Date(NOW).toISOString();
  const args = { businessId: BIZ, alertId: "a1", memberId: "m1", claimedByE164: DAVE, nowIso: NOW_ISO };

  it("claims when the row was still unclaimed", async () => {
    const { db, calls } = makeDb([{ data: [{ lead_e164: LEAD, lead_label: "Richard" }] }]);
    expect(await claimUnownedLeadAlert(db, args)).toEqual({
      ok: true,
      leadE164: LEAD,
      leadLabel: "Richard"
    });
    const upd = calls.find((c) => c.op === "update")!.payload as Record<string, unknown>;
    expect(upd.claimed_by_e164).toBe(DAVE);
    expect(upd.claimed_by_member_id).toBe("m1");
    expect(upd.claimed_at).toBe(NOW_ISO);
  });

  it("reports the winner when somebody else got there first", async () => {
    // PostgREST reports an update matching zero rows as a success with no
    // rows, which is exactly what the loser of a race sees.
    const { db } = makeDb([
      { data: [] },
      { data: { claimed_at: NOW_ISO, claimed_by_e164: GABBY } }
    ]);
    expect(await claimUnownedLeadAlert(db, args)).toEqual({
      ok: false,
      reason: "already_claimed",
      by: GABBY
    });
  });

  it("reports already_claimed even when the winner's number is unknown", async () => {
    const { db } = makeDb([{ data: [] }, { data: { claimed_at: NOW_ISO, claimed_by_e164: null } }]);
    expect(await claimUnownedLeadAlert(db, args)).toEqual({
      ok: false,
      reason: "already_claimed",
      by: null
    });
  });

  it("reports gone when the row expired or vanished", async () => {
    // "Dave already took it" and "that one is too old" call for different
    // next steps, so they are different outcomes.
    const { db } = makeDb([{ data: [] }, { data: null }]);
    expect(await claimUnownedLeadAlert(db, args)).toEqual({ ok: false, reason: "gone" });
  });

  it("reports gone when the row exists but was never claimed", async () => {
    const { db } = makeDb([{ data: [] }, { data: { claimed_at: null, claimed_by_e164: null } }]);
    expect(await claimUnownedLeadAlert(db, args)).toEqual({ ok: false, reason: "gone" });
  });

  it("treats a null update result as a lost race, not a claim", async () => {
    // PostgREST can answer with `data: null` rather than an empty array; the
    // loser of a race must never read that as a successful claim.
    const { db } = makeDb([{ data: null }, { data: { claimed_at: NOW_ISO, claimed_by_e164: GABBY } }]);
    expect(await claimUnownedLeadAlert(db, args)).toEqual({
      ok: false,
      reason: "already_claimed",
      by: GABBY
    });
  });

  it("reports gone on a write error rather than claiming", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb([{ error: { message: "nope" } }]);
    expect(await claimUnownedLeadAlert(db, args)).toEqual({ ok: false, reason: "gone" });
    err.mockRestore();
  });

  it("normalizes a blank label on a successful claim", async () => {
    const { db } = makeDb([{ data: [{ lead_e164: LEAD, lead_label: "  " }] }]);
    expect(await claimUnownedLeadAlert(db, args)).toEqual({
      ok: true,
      leadE164: LEAD,
      leadLabel: null
    });
  });

  it("carries a null member id through for an off-roster claimer", async () => {
    // The recipients list is what authorizes the reply, so a number not on
    // the roster still claims; it just cannot own the contact.
    const { db, calls } = makeDb([{ data: [{ lead_e164: LEAD, lead_label: null }] }]);
    await claimUnownedLeadAlert(db, { ...args, memberId: null });
    const upd = calls.find((c) => c.op === "update")!.payload as Record<string, unknown>;
    expect(upd.claimed_by_member_id).toBeNull();
  });
});
