import { describe, expect, it, vi } from "vitest";
import {
  flowBlocksReentry,
  hasPriorRunForLead,
  reentryBlocked
} from "../supabase/functions/_shared/ai_flows/reentry";

/**
 * Re-entry gate: a flow with options.allowReentry === false never re-enrolls
 * a contact who already has a (non-test) run of it. Identity is
 * cross-channel: the caller's phone/email key(s) are expanded through the
 * business's contact records before matching prior runs. Best-effort — a
 * lookup failure fails OPEN (the run enqueues) because a dropped lead is
 * worse than a duplicate follow-up.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+16025550111";
const LEAD_EMAIL = "lead@x.com";

type Scripted = { data?: unknown; error?: unknown };

/** Per-table FIFO fake: pops one scripted result per terminal await. */
function makeDb(byTable: Record<string, Scripted[]>) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  const queues: Record<string, Scripted[]> = Object.fromEntries(
    Object.entries(byTable).map(([k, v]) => [k, [...v]])
  );
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "or", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve((queues[table] ?? []).shift() ?? { data: null, error: null }).then(
        resolve
      );
    return builder;
  };
  return { db: { from }, calls };
}

/** No contact rows matched the expansion (keys pass through unchanged). */
const NO_EXPANSION: Scripted = { data: [], error: null };

const defWith = (options?: Record<string, unknown>) => ({
  version: 1,
  trigger: { channel: "sms", conditions: [] },
  steps: [],
  ...(options ? { options } : {})
});

describe("flowBlocksReentry", () => {
  it("only an explicit false blocks; default/true/malformed allow", () => {
    expect(flowBlocksReentry(defWith({ allowReentry: false }))).toBe(true);
    expect(flowBlocksReentry(defWith({ allowReentry: true }))).toBe(false);
    expect(flowBlocksReentry(defWith({}))).toBe(false);
    expect(flowBlocksReentry(defWith())).toBe(false);
    expect(flowBlocksReentry(null)).toBe(false);
    expect(flowBlocksReentry("junk")).toBe(false);
  });
});

describe("hasPriorRunForLead", () => {
  it("no usable keys → false without touching the db", async () => {
    const { db, calls } = makeDb({});
    expect(await hasPriorRunForLead(db, BIZ, "f1", "")).toBe(false);
    expect(await hasPriorRunForLead(db, BIZ, "f1", [null, undefined, "  "])).toBe(false);
    // Filter-grammar-hostile keys are dropped rather than injected.
    expect(await hasPriorRunForLead(db, BIZ, "f1", "a,b(c)")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a prior non-test run blocks; the query keys on flow + every identity path", async () => {
    const { db, calls } = makeDb({
      contacts: [NO_EXPANSION],
      ai_flow_runs: [{ data: [{ id: "r0", context: { trigger: { from: LEAD } } }], error: null }]
    });
    expect(await hasPriorRunForLead(db, BIZ, "f1", LEAD)).toBe(true);
    const runCalls = calls.filter((c) => c.table === "ai_flow_runs");
    expect(
      runCalls.some((c) => c.name === "eq" && c.args[0] === "flow_id" && c.args[1] === "f1")
    ).toBe(true);
    const identityOr = runCalls.find((c) => c.name === "or")!.args[0] as string;
    expect(identityOr).toContain(`context->trigger->>from.eq.${LEAD}`);
    expect(identityOr).toContain(`context->vars->>lead_phone.eq.${LEAD}`);
    expect(identityOr).toContain(`context->vars->>lead_email.eq.${LEAD}`);
    expect(identityOr).toContain(`context->waiting_reply->>from.eq.${LEAD}`);
    expect(identityOr).toContain(`context->waiting_call->>to.eq.${LEAD}`);
    // Test runs are excluded in the QUERY (second .or), so they can never
    // crowd real enrollments out of the scan slice.
    const testOr = runCalls.filter((c) => c.name === "or")[1]!.args[0] as string;
    expect(testOr).toContain("test_mode.is.null");
  });

  it("cross-channel: a contact match expands the key set (phone → email too)", async () => {
    const { db, calls } = makeDb({
      contacts: [
        {
          data: [
            { customer_e164: LEAD, email: LEAD_EMAIL, alias_e164s: ["+16025550999"] },
            // A second matched row with no aliases (merged duplicate) — its
            // null alias list and already-known keys are handled quietly.
            { customer_e164: LEAD, email: null, alias_e164s: null }
          ],
          error: null
        }
      ],
      ai_flow_runs: [
        { data: [{ id: "r0", context: { trigger: { from: LEAD_EMAIL } } }], error: null }
      ]
    });
    expect(await hasPriorRunForLead(db, BIZ, "f1", LEAD)).toBe(true);
    const contactsOr = calls.find((c) => c.table === "contacts" && c.name === "or")!
      .args[0] as string;
    expect(contactsOr).toContain(`customer_e164.eq.${LEAD}`);
    expect(contactsOr).toContain(`email.eq.${LEAD}`);
    expect(contactsOr).toContain(`alias_e164s.cs.{${LEAD}}`);
    const identityOr = calls.find((c) => c.table === "ai_flow_runs" && c.name === "or")!
      .args[0] as string;
    expect(identityOr).toContain(`.eq.${LEAD_EMAIL}`);
    expect(identityOr).toContain(".eq.+16025550999");
  });

  it("a contact-expansion failure still matches on the original keys", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failedExpansion = makeDb({
      contacts: [{ data: null, error: { message: "contacts down" } }],
      ai_flow_runs: [{ data: [{ id: "r0", context: {} }], error: null }]
    });
    expect(await hasPriorRunForLead(failedExpansion.db, BIZ, "f1", LEAD)).toBe(true);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("residual test-mode rows are still ignored (defense in depth)", async () => {
    const { db } = makeDb({
      contacts: [NO_EXPANSION],
      ai_flow_runs: [
        {
          data: [{ id: "r0", context: { trigger: { from: LEAD, test_mode: true } } }],
          error: null
        }
      ]
    });
    expect(await hasPriorRunForLead(db, BIZ, "f1", LEAD)).toBe(false);
  });

  it("no prior rows → false (null data too)", async () => {
    const empty = makeDb({ contacts: [NO_EXPANSION], ai_flow_runs: [{ data: [], error: null }] });
    expect(await hasPriorRunForLead(empty.db, BIZ, "f1", LEAD)).toBe(false);

    // Null pages on both lookups (PostgREST can return data: null).
    const nullData = makeDb({
      contacts: [{ data: null, error: null }],
      ai_flow_runs: [{ data: null, error: null }]
    });
    expect(await hasPriorRunForLead(nullData.db, BIZ, "f1", LEAD)).toBe(false);
  });

  it("fails OPEN on a run-lookup error or a client blow-up", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const lookupErr = makeDb({
      contacts: [NO_EXPANSION],
      ai_flow_runs: [{ data: null, error: { message: "down" } }]
    });
    expect(await hasPriorRunForLead(lookupErr.db, BIZ, "f1", LEAD)).toBe(false);

    const thrown = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await hasPriorRunForLead(thrown, BIZ, "f1", LEAD)).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("caps the expanded key set (a hoarder contact can't blow up the filter)", async () => {
    const { db, calls } = makeDb({
      contacts: [
        {
          data: [
            {
              customer_e164: LEAD,
              email: LEAD_EMAIL,
              alias_e164s: Array.from({ length: 30 }, (_, i) => `+1602555${1000 + i}`)
            }
          ],
          error: null
        }
      ],
      ai_flow_runs: [{ data: [], error: null }]
    });
    await hasPriorRunForLead(db, BIZ, "f1", LEAD);
    const identityOr = calls.find((c) => c.table === "ai_flow_runs" && c.name === "or")!
      .args[0] as string;
    // 12 keys max × 6 paths.
    expect(identityOr.split(",").length).toBeLessThanOrEqual(72);
  });
});

describe("reentryBlocked", () => {
  it("a flow that allows re-entry (the default) never queries the db", async () => {
    const { db, calls } = makeDb({});
    expect(await reentryBlocked(db, BIZ, "f1", defWith(), LEAD)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("no lead identity → never blocked (webhook-style enqueues pass through)", async () => {
    const { db, calls } = makeDb({});
    expect(await reentryBlocked(db, BIZ, "f1", defWith({ allowReentry: false }), "")).toBe(
      false
    );
    expect(
      await reentryBlocked(db, BIZ, "f1", defWith({ allowReentry: false }), [null])
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("blocks when the flow opts out and the lead already ran it", async () => {
    const { db } = makeDb({
      contacts: [NO_EXPANSION],
      ai_flow_runs: [{ data: [{ id: "r0", context: { trigger: { from: LEAD } } }], error: null }]
    });
    expect(await reentryBlocked(db, BIZ, "f1", defWith({ allowReentry: false }), LEAD)).toBe(
      true
    );
  });

  it("does not block a first enrollment", async () => {
    const { db } = makeDb({
      contacts: [NO_EXPANSION],
      ai_flow_runs: [{ data: [], error: null }]
    });
    expect(await reentryBlocked(db, BIZ, "f1", defWith({ allowReentry: false }), LEAD)).toBe(
      false
    );
  });
});
