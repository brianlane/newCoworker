import { describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_CALLED_DEFER_MINUTES,
  CUSTOMER_CALLED_SENTINEL,
  CUSTOMER_CALLED_TAG,
  pauseLeadAutomationOnCall
} from "../supabase/functions/_shared/ai_flows/customer_called";

/**
 * "Customer Called" pause: a lead who phones in must stop receiving automated
 * texts — parked waits resolve with the customer_called sentinel, queued
 * follow-ups defer, and the contact is tagged. All best-effort.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const CALLER = "+16474494244";
const NOW = Date.parse("2026-07-10T12:00:00Z");

type Scripted = { data?: unknown; error?: unknown };

/**
 * Chainable builder: pops one scripted result per terminal await, records
 * every call for wire-shape assertions.
 */
function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "update", "eq", "or", "in", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = async () => {
      calls.push({ table, name: "maybeSingle", args: [] });
      return next();
    };
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

describe("pauseLeadAutomationOnCall", () => {
  it("no caller → noop without touching the db", async () => {
    const { db, calls } = makeDb([]);
    const res = await pauseLeadAutomationOnCall(db, BIZ, "");
    expect(res).toEqual({ resumedWaits: 0, deferredRuns: 0, tagged: false });
    expect(calls).toHaveLength(0);
  });

  it("never throws: a client blow-up returns the noop result", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      from: () => {
        throw new Error("boom");
      }
    };
    const res = await pauseLeadAutomationOnCall(db, BIZ, CALLER);
    expect(res).toEqual({ resumedWaits: 0, deferredRuns: 0, tagged: false });
    err.mockRestore();
  });

  it("resumes parked waits with the sentinel (default + custom saveAs, marker stamped)", async () => {
    const { db, calls } = makeDb([
      {
        data: [
          { id: "r1", context: { vars: { lead_phone: CALLER }, waiting_reply: { from: CALLER } }, revision: 3 },
          {
            id: "r2",
            context: { waiting_reply: { from: CALLER, save_as: "answer", marker: "__waited_w1" } },
            revision: 1
          }
        ],
        error: null
      },
      { data: [{ id: "r1" }], error: null }, // r1 resume landed
      { data: [], error: null }, // r2 lost the revision race
      { data: [], error: null }, // queued defer: none
      // resumed > 0 → contact tag path
      { data: { id: "c1", tags: [] }, error: null },
      { data: null, error: null } // tag update
    ]);
    const res = await pauseLeadAutomationOnCall(db, BIZ, CALLER, NOW);
    expect(res).toEqual({ resumedWaits: 1, deferredRuns: 0, tagged: true });

    // r1: default saveAs (reply_text), existing vars preserved.
    const firstUpdate = calls.filter((c) => c.name === "update")[0]
      .args[0] as Record<string, unknown>;
    const ctx1 = firstUpdate.context as {
      vars: Record<string, unknown>;
      waiting_reply: Record<string, unknown>;
    };
    expect(firstUpdate.status).toBe("queued");
    expect(ctx1.vars.reply_text).toBe(CUSTOMER_CALLED_SENTINEL);
    expect(ctx1.vars.lead_phone).toBe(CALLER);
    expect(ctx1.waiting_reply.result).toBe(CUSTOMER_CALLED_SENTINEL);

    // r2: custom saveAs + per-step marker stamped alongside.
    const secondUpdate = calls.filter((c) => c.name === "update")[1]
      .args[0] as Record<string, unknown>;
    const ctx2 = secondUpdate.context as { vars: Record<string, unknown> };
    expect(ctx2.vars.answer).toBe(CUSTOMER_CALLED_SENTINEL);
    expect(ctx2.vars.__waited_w1).toBe("1");
  });

  it("defers only the caller's queued runs that would wake sooner, then tags the contact", async () => {
    const resumeIso = new Date(NOW + CUSTOMER_CALLED_DEFER_MINUTES * 60_000).toISOString();
    const { db, calls } = makeDb([
      { data: [], error: null }, // no parked waits
      {
        // Queued lookup: q1 (never deferred) and q2 (wakes sooner) get pushed;
        // q3 already sleeps PAST the window and must keep its later time.
        data: [
          { id: "q1", earliest_claim_at: null },
          { id: "q2", earliest_claim_at: new Date(NOW + 10 * 60_000).toISOString() },
          { id: "q3", earliest_claim_at: new Date(NOW + 10 * 60 * 60_000).toISOString() }
        ],
        error: null
      },
      { data: [{ id: "q1" }, { id: "q2" }], error: null }, // defer update
      { data: { id: "c1", tags: ["New Lead"] }, error: null },
      { data: null, error: null }
    ]);
    const res = await pauseLeadAutomationOnCall(db, BIZ, CALLER, NOW);
    expect(res).toEqual({ resumedWaits: 0, deferredRuns: 2, tagged: true });

    // Lead matching (sender OR extracted phone) is the ONLY .or() — the
    // wake-sooner guard is applied client-side (Bugbot 17abe4a0: two chained
    // .or() trees on one PostgREST update clobber each other).
    const ors = calls.filter((c) => c.name === "or" && c.table === "ai_flow_runs");
    expect(ors).toHaveLength(1);
    expect(String(ors[0].args[0])).toContain("context->trigger->>from");
    expect(String(ors[0].args[0])).toContain("lead_phone");
    const inCall = calls.find((c) => c.name === "in");
    expect(inCall!.args).toEqual(["id", ["q1", "q2"]]);
    const deferUpdate = calls.find((c) => c.name === "update" && c.table === "ai_flow_runs");
    expect((deferUpdate!.args[0] as Record<string, unknown>).earliest_claim_at).toBe(resumeIso);

    const tagUpdate = calls.filter((c) => c.table === "contacts" && c.name === "update")[0];
    expect((tagUpdate.args[0] as Record<string, unknown>).tags).toEqual([
      "New Lead",
      CUSTOMER_CALLED_TAG
    ]);
  });

  it("skips the defer update entirely when every queued run already sleeps past the window", async () => {
    const { db, calls } = makeDb([
      { data: [], error: null },
      {
        data: [{ id: "q1", earliest_claim_at: new Date(NOW + 24 * 60 * 60_000).toISOString() }],
        error: null
      }
    ]);
    const res = await pauseLeadAutomationOnCall(db, BIZ, CALLER, NOW);
    expect(res).toEqual({ resumedWaits: 0, deferredRuns: 0, tagged: false });
    expect(calls.some((c) => c.name === "in")).toBe(false);
  });

  it("treats null data pages as empty (lookup, resume, defer)", async () => {
    const nullLookup = makeDb([
      { data: null, error: null }, // waits lookup returns null
      { data: null, error: null } // defer returns null
    ]);
    expect(await pauseLeadAutomationOnCall(nullLookup.db, BIZ, CALLER, NOW)).toEqual({
      resumedWaits: 0,
      deferredRuns: 0,
      tagged: false
    });

    const nullResume = makeDb([
      { data: [{ id: "r1", context: null, revision: 1 }], error: null },
      { data: null, error: null }, // resume update returns null data
      { data: null, error: null }
    ]);
    expect(await pauseLeadAutomationOnCall(nullResume.db, BIZ, CALLER, NOW)).toEqual({
      resumedWaits: 0,
      deferredRuns: 0,
      tagged: false
    });

    const nullDeferUpdate = makeDb([
      { data: [], error: null },
      { data: [{ id: "q1", earliest_claim_at: null }], error: null },
      { data: null, error: null } // defer update returns null data
    ]);
    expect(await pauseLeadAutomationOnCall(nullDeferUpdate.db, BIZ, CALLER, NOW)).toEqual({
      resumedWaits: 0,
      deferredRuns: 0,
      tagged: false
    });
  });

  it("skips tagging entirely when the call touched no active automation", async () => {
    const { db, calls } = makeDb([
      { data: [], error: null },
      { data: [], error: null }
    ]);
    const res = await pauseLeadAutomationOnCall(db, BIZ, CALLER, NOW);
    expect(res).toEqual({ resumedWaits: 0, deferredRuns: 0, tagged: false });
    expect(calls.some((c) => c.table === "contacts")).toBe(false);
  });

  it("tag path: missing contact, already tagged (case-insensitive), and full tag list all no-op", async () => {
    // Common prefix: no waits; one never-deferred queued run that updates.
    const queuedPrefix: Scripted[] = [
      { data: [], error: null },
      { data: [{ id: "q1", earliest_claim_at: null }], error: null },
      { data: [{ id: "q1" }], error: null }
    ];
    const missing = makeDb([...queuedPrefix, { data: null, error: null }]); // no contact row
    expect((await pauseLeadAutomationOnCall(missing.db, BIZ, CALLER, NOW)).tagged).toBe(false);

    const already = makeDb([
      ...queuedPrefix,
      { data: { id: "c1", tags: ["customer called"] }, error: null }
    ]);
    expect((await pauseLeadAutomationOnCall(already.db, BIZ, CALLER, NOW)).tagged).toBe(false);

    const full = makeDb([
      ...queuedPrefix,
      { data: { id: "c1", tags: Array.from({ length: 25 }, (_, i) => `t${i}`) }, error: null }
    ]);
    expect((await pauseLeadAutomationOnCall(full.db, BIZ, CALLER, NOW)).tagged).toBe(false);

    // Null tags column treated as empty list.
    const nullTags = makeDb([
      ...queuedPrefix,
      { data: { id: "c1", tags: null }, error: null },
      { data: null, error: null }
    ]);
    expect((await pauseLeadAutomationOnCall(nullTags.db, BIZ, CALLER, NOW)).tagged).toBe(true);
  });

  it("swallows per-query errors (lookup, resume, defer select/update, contact, tag write)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const lookupErr = makeDb([
      { data: null, error: { message: "waits down" } },
      { data: null, error: { message: "defer lookup down" } }
    ]);
    expect(await pauseLeadAutomationOnCall(lookupErr.db, BIZ, CALLER, NOW)).toEqual({
      resumedWaits: 0,
      deferredRuns: 0,
      tagged: false
    });

    const resumeErr = makeDb([
      { data: [{ id: "r1", context: null, revision: 1 }], error: null },
      { data: null, error: { message: "resume down" } }, // r1 update fails
      { data: [{ id: "q1", earliest_claim_at: null }], error: null },
      { data: [{ id: "q1" }], error: null }, // defer update ok
      { data: null, error: { message: "contact down" } } // contact lookup fails
    ]);
    expect(await pauseLeadAutomationOnCall(resumeErr.db, BIZ, CALLER, NOW)).toEqual({
      resumedWaits: 0,
      deferredRuns: 1,
      tagged: false
    });

    const deferUpdateErr = makeDb([
      { data: [], error: null },
      { data: [{ id: "q1", earliest_claim_at: null }], error: null },
      { data: null, error: { message: "defer update down" } }
    ]);
    expect(await pauseLeadAutomationOnCall(deferUpdateErr.db, BIZ, CALLER, NOW)).toEqual({
      resumedWaits: 0,
      deferredRuns: 0,
      tagged: false
    });

    const tagErr = makeDb([
      { data: [], error: null },
      { data: [{ id: "q1", earliest_claim_at: null }], error: null },
      { data: [{ id: "q1" }], error: null },
      { data: { id: "c1", tags: [] }, error: null },
      { data: null, error: { message: "tag write down" } }
    ]);
    expect((await pauseLeadAutomationOnCall(tagErr.db, BIZ, CALLER, NOW)).tagged).toBe(false);
    err.mockRestore();
  });
});
