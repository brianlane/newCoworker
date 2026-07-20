import { describe, expect, it, vi } from "vitest";
import {
  duplicateLeadRunExists,
  flowBlocksReentry,
  flowDedupesLeadRuns,
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
    for (const m of ["select", "eq", "neq", "lt", "not", "or", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = () => {
      calls.push({ table, name: "maybeSingle", args: [] });
      return Promise.resolve((queues[table] ?? []).shift() ?? { data: null, error: null });
    };
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

describe("flowDedupesLeadRuns", () => {
  it("only an explicit true opts in", () => {
    expect(flowDedupesLeadRuns(defWith({ dedupeLeadRuns: true }))).toBe(true);
    expect(flowDedupesLeadRuns(defWith({ dedupeLeadRuns: false }))).toBe(false);
    expect(flowDedupesLeadRuns(defWith({}))).toBe(false);
    expect(flowDedupesLeadRuns(defWith())).toBe(false);
    expect(flowDedupesLeadRuns(null)).toBe(false);
    expect(flowDedupesLeadRuns("junk")).toBe(false);
  });
});

describe("duplicateLeadRunExists", () => {
  const RUN = "11111111-1111-1111-1111-111111111111";
  const ADDR = "24027 S 121st Pl, Chandler, AZ 85249, USA";
  /** Self created_at row every happy-path scenario needs first. */
  const SELF: Scripted = { data: { created_at: "2026-07-20T02:40:00Z" }, error: null };
  const priorRun = (vars: Record<string, unknown>): Scripted => ({
    data: [{ id: "r0", context: { trigger: { from: "" }, vars } }],
    error: null
  });

  it("no usable person keys → false without touching the db", async () => {
    const { db, calls } = makeDb({});
    expect(await duplicateLeadRunExists(db, BIZ, "f1", RUN, {})).toBe(false);
    expect(
      await duplicateLeadRunExists(db, BIZ, "f1", RUN, { phone: "  ", email: null, address: ADDR })
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("same person + same property (case/whitespace-insensitive) blocks", async () => {
    const { db, calls } = makeDb({
      contacts: [NO_EXPANSION],
      ai_flow_runs: [SELF, priorRun({ lead_phone: "480-274-0963", lead_address: `  ${ADDR.toUpperCase()}  ` })]
    });
    expect(
      await duplicateLeadRunExists(db, BIZ, "f1", RUN, {
        phone: "480-274-0963",
        email: "lead@x.com",
        address: ADDR
      })
    ).toBe(true);
    // The raw phone is normalized to E.164 as a second key, and the scan is
    // pinned to strictly-earlier, non-failed, non-canceled sibling runs.
    const runCalls = calls.filter((c) => c.table === "ai_flow_runs");
    const identityOr = runCalls.find((c) => c.name === "or")!.args[0] as string;
    expect(identityOr).toContain(".eq.480-274-0963");
    expect(identityOr).toContain(".eq.+14802740963");
    expect(identityOr).toContain(".eq.lead@x.com");
    expect(runCalls.some((c) => c.name === "neq" && c.args[1] === RUN)).toBe(true);
    expect(
      runCalls.some((c) => c.name === "lt" && c.args[0] === "created_at")
    ).toBe(true);
    expect(
      runCalls.some((c) => c.name === "not" && c.args[2] === "(failed,canceled)")
    ).toBe(true);
  });

  it("same person but a DIFFERENT property is a new lead", async () => {
    const { db } = makeDb({
      contacts: [NO_EXPANSION],
      ai_flow_runs: [SELF, priorRun({ lead_phone: LEAD, lead_address: "409 E Woodman Dr, Tempe, AZ" })]
    });
    expect(
      await duplicateLeadRunExists(db, BIZ, "f1", RUN, { phone: LEAD, address: ADDR })
    ).toBe(false);
  });

  it("a prior run with NO address can't prove a different property — the person match stands", async () => {
    const { db } = makeDb({
      contacts: [NO_EXPANSION],
      ai_flow_runs: [SELF, priorRun({ lead_phone: LEAD })]
    });
    expect(
      await duplicateLeadRunExists(db, BIZ, "f1", RUN, { phone: LEAD, address: ADDR })
    ).toBe(true);
  });

  it("a current run with no address matches on the person alone", async () => {
    const { db } = makeDb({
      contacts: [NO_EXPANSION],
      ai_flow_runs: [SELF, priorRun({ lead_phone: LEAD, lead_address: ADDR })]
    });
    expect(await duplicateLeadRunExists(db, BIZ, "f1", RUN, { phone: LEAD })).toBe(true);
  });

  it("residual test-mode rows are ignored (defense in depth)", async () => {
    const { db } = makeDb({
      contacts: [NO_EXPANSION],
      ai_flow_runs: [
        SELF,
        {
          data: [
            {
              id: "r0",
              context: { trigger: { from: "", test_mode: true }, vars: { lead_phone: LEAD } }
            }
          ],
          error: null
        }
      ]
    });
    expect(await duplicateLeadRunExists(db, BIZ, "f1", RUN, { phone: LEAD })).toBe(false);
  });

  it("fails OPEN when the self row is missing or errored (no created_at to order by)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const missingSelf = makeDb({ ai_flow_runs: [{ data: null, error: null }] });
    expect(
      await duplicateLeadRunExists(missingSelf.db, BIZ, "f1", RUN, { phone: LEAD })
    ).toBe(false);

    const selfError = makeDb({ ai_flow_runs: [{ data: null, error: { message: "down" } }] });
    expect(
      await duplicateLeadRunExists(selfError.db, BIZ, "f1", RUN, { phone: LEAD })
    ).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("fails OPEN on a list-lookup error or a client blow-up", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const listError = makeDb({
      contacts: [NO_EXPANSION],
      ai_flow_runs: [SELF, { data: null, error: { message: "down" } }]
    });
    expect(
      await duplicateLeadRunExists(listError.db, BIZ, "f1", RUN, { phone: LEAD })
    ).toBe(false);

    const thrown = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await duplicateLeadRunExists(thrown, BIZ, "f1", RUN, { phone: LEAD })).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("no prior rows → false (null data too)", async () => {
    const empty = makeDb({
      contacts: [NO_EXPANSION],
      ai_flow_runs: [SELF, { data: [], error: null }]
    });
    expect(await duplicateLeadRunExists(empty.db, BIZ, "f1", RUN, { phone: LEAD })).toBe(false);

    const nullData = makeDb({
      contacts: [NO_EXPANSION],
      ai_flow_runs: [SELF, { data: null, error: null }]
    });
    expect(await duplicateLeadRunExists(nullData.db, BIZ, "f1", RUN, { phone: LEAD })).toBe(
      false
    );
  });
});
