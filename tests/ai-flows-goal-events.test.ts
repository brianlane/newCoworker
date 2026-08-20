import { describe, expect, it, vi } from "vitest";
import {
  GOAL_JUMP_SKIP,
  applyGoalEvent,
  goalReachedVar,
  goalStepMatches
} from "../supabase/functions/_shared/ai_flows/goal_events";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

/**
 * Goal Events: an external milestone (reply / booking / tag / claim) fast-
 * forwards a lead's queued or reply-parked runs to the first matching goal
 * checkpoint ahead of current_step, recording the skipped steps. Best-effort
 * everywhere: no failure here may break the hook that observed the event.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+16025550111";

type GoalStep = Extract<FlowStep, { type: "goal" }>;

const goal = (id: string, events: GoalStep["events"]): GoalStep => ({
  id,
  type: "goal",
  label: `Goal ${id}`,
  events
});

const sms = (id: string): FlowStep => ({ id, type: "send_sms", to: "{{vars.p}}", body: "hi" });

describe("goalReachedVar", () => {
  it("prefixes with __goal_ so the dashboard var listing hides it", () => {
    expect(goalReachedVar("g1")).toBe("__goal_g1");
  });
});

describe("goalStepMatches", () => {
  it("matches a plain event kind and rejects others", () => {
    const step = goal("g", [{ kind: "replied" }, { kind: "claimed" }]);
    expect(goalStepMatches(step, { kind: "replied" })).toBe(true);
    expect(goalStepMatches(step, { kind: "claimed" })).toBe(true);
    expect(goalStepMatches(step, { kind: "appointment_booked" })).toBe(false);
  });

  it("tag_added matches on the tag, case-insensitively", () => {
    const step = goal("g", [{ kind: "tag_added", tag: "Appointment Scheduled" }]);
    expect(goalStepMatches(step, { kind: "tag_added", tag: "appointment scheduled" })).toBe(true);
    expect(goalStepMatches(step, { kind: "tag_added", tag: "Engaged" })).toBe(false);
    expect(goalStepMatches(step, { kind: "replied" })).toBe(false);
  });

  it("a tag_added goal without a tag never matches (runtime defense)", () => {
    const step = goal("g", [{ kind: "tag_added" }]);
    expect(goalStepMatches(step, { kind: "tag_added", tag: "Engaged" })).toBe(false);
    expect(goalStepMatches(step, { kind: "tag_added" })).toBe(false);
  });

  it("tolerates malformed stored events (non-array, null entries)", () => {
    const bad1 = { ...goal("g", []), events: null } as unknown as GoalStep;
    expect(goalStepMatches(bad1, { kind: "replied" })).toBe(false);
    const bad2 = { ...goal("g", []), events: [null] } as unknown as GoalStep;
    expect(goalStepMatches(bad2, { kind: "replied" })).toBe(false);
  });
});

type Scripted = { data?: unknown; error?: unknown };

/**
 * Chainable builder: pops one scripted result per terminal await, records
 * every call for wire-shape assertions (mirrors customer-called.test.ts).
 */
function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "update", "upsert", "eq", "is", "or", "in", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

/** A run row as the candidate lookup returns it. */
function runRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "r1",
    flow_id: "f1",
    business_id: BIZ,
    status: "queued",
    current_step: 0,
    context: { vars: {}, trigger: { from: LEAD } },
    revision: 5,
    // What the run was enqueued under; null for anything not event-started.
    dedupe_key: null,
    ...over
  };
}

/** An ai_flows row wrapping the given steps. */
function flowRow(id: string, steps: FlowStep[]) {
  return { id, definition: { version: 1, trigger: { channel: "sms", conditions: [] }, steps } };
}

describe("applyGoalEvent", () => {
  it("no lead phone → noop without touching the db", async () => {
    const { db, calls } = makeDb([]);
    expect(await applyGoalEvent(db, BIZ, "", { kind: "replied" })).toEqual({ jumpedRuns: 0 });
    expect(calls).toHaveLength(0);
  });

  it("matches an EMAIL-identified lead on the contact key and lead_email", async () => {
    // The gap this closes: an email-only lead has no phone in any of the four
    // number slots, so a booking never reached their run and the `converted`
    // jump never fired. They kept getting follow-ups after booking.
    const { db, calls } = makeDb([{ data: [], error: null }]);
    await applyGoalEvent(db, BIZ, "email:valm0417@gmail.com", { kind: "appointment_booked" });
    const filter = String(calls.find((c) => c.name === "or")?.args[0] ?? "");
    // trigger.from carries the KEY on a contact-event run (set by the engine,
    // not by an authored var name), so it is the reliable half.
    expect(filter).toContain("context->trigger->>from.eq.email:valm0417@gmail.com");
    expect(filter).toContain("context->vars->>lead_email.ilike.valm0417@gmail.com");
    // The phone slots are meaningless for this lead and are not searched.
    expect(filter).not.toContain("lead_phone");
    expect(filter).not.toContain("waiting_call");
  });

  it("accepts a BARE address, and matches lead_email case-insensitively", async () => {
    // Callers hold an address (an attendee email on a booking), not a key. And
    // `lead_email` stores whatever casing the extraction produced, so an exact
    // match would silently never fire, which is the same casing trap that bit
    // the staff guard and the duplicate-lead guard.
    const { db, calls } = makeDb([{ data: [], error: null }]);
    await applyGoalEvent(db, BIZ, "Valm0417@Gmail.com", { kind: "appointment_booked" });
    const filter = String(calls.find((c) => c.name === "or")?.args[0] ?? "");
    expect(filter).toContain("context->trigger->>from.eq.email:valm0417@gmail.com");
    expect(filter).toContain("context->vars->>lead_email.ilike.valm0417@gmail.com");
  });

  it("escapes the LIKE wildcards in an address so it cannot match a different person", async () => {
    const { db, calls } = makeDb([{ data: [], error: null }]);
    await applyGoalEvent(db, BIZ, "first_last@example.com", { kind: "appointment_booked" });
    const filter = String(calls.find((c) => c.name === "or")?.args[0] ?? "");
    expect(filter).toContain("lead_email.ilike.first\\_last@example.com");
  });

  it("keeps all four number slots for a phone lead", async () => {
    const { db, calls } = makeDb([{ data: [], error: null }]);
    await applyGoalEvent(db, BIZ, LEAD, { kind: "replied" });
    const filter = String(calls.find((c) => c.name === "or")?.args[0] ?? "");
    for (const slot of [
      `context->trigger->>from.eq.${LEAD}`,
      `context->vars->>lead_phone.eq.${LEAD}`,
      `context->waiting_reply->>from.eq.${LEAD}`,
      `context->waiting_call->>to.eq.${LEAD}`
    ]) {
      expect(filter).toContain(slot);
    }
  });

  it("never throws: a client blow-up returns the noop result", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await applyGoalEvent(db, BIZ, LEAD, { kind: "replied" })).toEqual({ jumpedRuns: 0 });
    err.mockRestore();
  });

  it("run lookup error / empty page → noop", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const lookupErr = makeDb([{ data: null, error: { message: "down" } }]);
    expect(await applyGoalEvent(lookupErr.db, BIZ, LEAD, { kind: "replied" })).toEqual({
      jumpedRuns: 0
    });
    const empty = makeDb([{ data: [], error: null }]);
    expect(await applyGoalEvent(empty.db, BIZ, LEAD, { kind: "replied" })).toEqual({
      jumpedRuns: 0
    });
    const nullPage = makeDb([{ data: null, error: null }]);
    expect(await applyGoalEvent(nullPage.db, BIZ, LEAD, { kind: "replied" })).toEqual({
      jumpedRuns: 0
    });
    err.mockRestore();
  });

  it("flow lookup error / disabled / malformed definitions → no jumps", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const flowErr = makeDb([
      { data: [runRow()], error: null },
      { data: null, error: { message: "flows down" } }
    ]);
    expect(await applyGoalEvent(flowErr.db, BIZ, LEAD, { kind: "replied" })).toEqual({
      jumpedRuns: 0
    });

    // Flow row missing (disabled flows are filtered by the query) and a
    // malformed definition both drop the run.
    const malformed = makeDb([
      { data: [runRow(), runRow({ id: "r2", flow_id: "f2" })], error: null },
      { data: [{ id: "f2", definition: { steps: "not-an-array" } }], error: null }
    ]);
    expect(await applyGoalEvent(malformed.db, BIZ, LEAD, { kind: "replied" })).toEqual({
      jumpedRuns: 0
    });

    // A null flow page (no error, no rows) is treated as empty.
    const nullFlows = makeDb([
      { data: [runRow()], error: null },
      { data: null, error: null }
    ]);
    expect(await applyGoalEvent(nullFlows.db, BIZ, LEAD, { kind: "replied" })).toEqual({
      jumpedRuns: 0
    });
    err.mockRestore();
  });

  it("jumps a queued run to the first matching goal ahead, recording skipped steps", async () => {
    const steps = [sms("s0"), sms("s1"), goal("g1", [{ kind: "replied" }])];
    const { db, calls } = makeDb([
      { data: [runRow({ current_step: 1 })], error: null },
      { data: [flowRow("f1", steps)], error: null },
      { data: [{ id: "r1" }], error: null }, // jump update landed
      { data: null, error: null } // skip upsert for s1
    ]);
    expect(await applyGoalEvent(db, BIZ, LEAD, { kind: "replied" })).toEqual({ jumpedRuns: 1 });

    // Candidate query is status-bounded and lead-matched.
    const inCalls = calls.filter((c) => c.name === "in" && c.table === "ai_flow_runs");
    expect(inCalls[0].args).toEqual(["status", ["queued", "awaiting_reply", "awaiting_call"]]);
    const orCall = calls.find((c) => c.name === "or");
    expect(String(orCall!.args[0])).toContain("context->trigger->>from");
    expect(String(orCall!.args[0])).toContain("lead_phone");
    expect(String(orCall!.args[0])).toContain("waiting_reply");
    expect(String(orCall!.args[0])).toContain("waiting_call");

    // The jump: forward to the goal's flat index, park state cleared, the
    // reached-via var stamped.
    const update = calls.find((c) => c.name === "update" && c.table === "ai_flow_runs")!
      .args[0] as Record<string, unknown>;
    expect(update.status).toBe("queued");
    expect(update.current_step).toBe(2);
    expect(update.earliest_claim_at).toBeNull();
    expect(update.respond_by_at).toBeNull();
    const ctx = update.context as { vars: Record<string, unknown> };
    expect(ctx.vars[goalReachedVar("g1")]).toBe("replied");

    // Only the leapfrogged step (index 1) is recorded skipped.
    const upserts = calls.filter((c) => c.name === "upsert");
    expect(upserts).toHaveLength(1);
    const row = upserts[0].args[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      run_id: "r1",
      business_id: BIZ,
      step_index: 1,
      step_type: "send_sms",
      status: "skipped"
    });
    expect(row.result).toEqual({
      skipped: GOAL_JUMP_SKIP,
      goal_step_id: "g1",
      event: "replied"
    });
    expect(upserts[0].args[1]).toEqual({ onConflict: "run_id,step_index" });
  });

  it("awaiting_reply runs get waiting_reply.result and the wait marker stamped", async () => {
    const steps = [sms("s0"), goal("g1", [{ kind: "appointment_booked" }])];
    const { db, calls } = makeDb([
      {
        data: [
          runRow({
            status: "awaiting_reply",
            current_step: 0,
            context: {
              vars: { p: LEAD },
              waiting_reply: { from: LEAD, save_as: "reply_text", marker: "__waited_w1" }
            }
          })
        ],
        error: null
      },
      { data: [flowRow("f1", steps)], error: null },
      { data: [{ id: "r1" }], error: null },
      { data: null, error: null } // skip upsert for s0
    ]);
    expect(await applyGoalEvent(db, BIZ, LEAD, { kind: "appointment_booked" })).toEqual({
      jumpedRuns: 1
    });
    const update = calls.find((c) => c.name === "update" && c.table === "ai_flow_runs")!
      .args[0] as Record<string, unknown>;
    const ctx = update.context as {
      vars: Record<string, unknown>;
      waiting_reply: Record<string, unknown>;
    };
    expect(ctx.vars.__waited_w1).toBe("1");
    expect(ctx.vars[goalReachedVar("g1")]).toBe("appointment_booked");
    expect(ctx.waiting_reply.result).toBe(GOAL_JUMP_SKIP);
  });

  it("awaiting_call runs get waiting_call.result and the dial marker stamped (never re-dials)", async () => {
    const steps = [sms("s0"), goal("g1", [{ kind: "appointment_booked" }])];
    const { db, calls } = makeDb([
      {
        data: [
          runRow({
            status: "awaiting_call",
            current_step: 0,
            context: {
              vars: { lead_phone: LEAD },
              waiting_call: { to: LEAD, save_as: "call_outcome", marker: "__called_c1" }
            }
          })
        ],
        error: null
      },
      { data: [flowRow("f1", steps)], error: null },
      { data: [{ id: "r1" }], error: null },
      { data: null, error: null } // skip upsert for s0
    ]);
    expect(await applyGoalEvent(db, BIZ, LEAD, { kind: "appointment_booked" })).toEqual({
      jumpedRuns: 1
    });
    const update = calls.find((c) => c.name === "update" && c.table === "ai_flow_runs")!
      .args[0] as Record<string, unknown>;
    const ctx = update.context as {
      vars: Record<string, unknown>;
      waiting_call: Record<string, unknown>;
    };
    // The marker guarantees the place_ai_call step is a no-op on any
    // re-entry, a goal jump must never cause a second dial.
    expect(ctx.vars.__called_c1).toBe("1");
    expect(ctx.vars[goalReachedVar("g1")]).toBe("appointment_booked");
    expect(ctx.waiting_call.result).toBe(GOAL_JUMP_SKIP);
    expect(ctx).not.toHaveProperty("waiting_reply");
  });

  it("an awaiting_call run without a stored marker still jumps (defensive)", async () => {
    const steps = [sms("s0"), goal("g1", [{ kind: "replied" }])];
    const { db, calls } = makeDb([
      {
        data: [
          runRow({
            status: "awaiting_call",
            current_step: 0,
            context: { vars: { lead_phone: LEAD }, waiting_call: { to: LEAD } }
          })
        ],
        error: null
      },
      { data: [flowRow("f1", steps)], error: null },
      { data: [{ id: "r1" }], error: null },
      { data: null, error: null }
    ]);
    expect(await applyGoalEvent(db, BIZ, LEAD, { kind: "replied" })).toEqual({ jumpedRuns: 1 });
    const update = calls.find((c) => c.name === "update" && c.table === "ai_flow_runs")!
      .args[0] as Record<string, unknown>;
    const ctx = update.context as { waiting_call: Record<string, unknown> };
    expect(ctx.waiting_call.result).toBe(GOAL_JUMP_SKIP);
  });

  it("excludeRunIds keeps the freshly-resumed wait run on its authored path", async () => {
    const steps = [sms("s0"), goal("g1", [{ kind: "replied" }])];
    const { db, calls } = makeDb([
      { data: [runRow()], error: null },
      { data: [flowRow("f1", steps)], error: null }
    ]);
    expect(await applyGoalEvent(db, BIZ, LEAD, { kind: "replied" }, ["r1"])).toEqual({
      jumpedRuns: 0
    });
    expect(calls.some((c) => c.name === "update")).toBe(false);
  });

  it("no jump when the only goals are behind, non-matching, or inside a branch arm", async () => {
    // Behind: goal at index 0, run already at 1.
    const behind = makeDb([
      { data: [runRow({ current_step: 1 })], error: null },
      { data: [flowRow("f1", [goal("g0", [{ kind: "replied" }]), sms("s1")])], error: null }
    ]);
    expect(await applyGoalEvent(behind.db, BIZ, LEAD, { kind: "replied" })).toEqual({
      jumpedRuns: 0
    });

    // Non-matching event kind.
    const wrongKind = makeDb([
      { data: [runRow()], error: null },
      { data: [flowRow("f1", [sms("s0"), goal("g1", [{ kind: "claimed" }])])], error: null }
    ]);
    expect(await applyGoalEvent(wrongKind.db, BIZ, LEAD, { kind: "replied" })).toEqual({
      jumpedRuns: 0
    });

    // A goal nested in a branch arm is never a jump target (trunk-only).
    const branchStep: FlowStep = {
      id: "b1",
      type: "branch",
      question: "path?",
      branches: [
        {
          id: "arm1",
          label: "Arm",
          condition: { var: "x", equals: "y" },
          steps: [goal("gNested", [{ kind: "replied" }])]
        }
      ],
      else: []
    };
    const nested = makeDb([
      { data: [runRow()], error: null },
      { data: [flowRow("f1", [sms("s0"), branchStep])], error: null }
    ]);
    expect(await applyGoalEvent(nested.db, BIZ, LEAD, { kind: "replied" })).toEqual({
      jumpedRuns: 0
    });
  });

  it("a lost revision race or update error is not counted and records no skips", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const steps = [sms("s0"), goal("g1", [{ kind: "replied" }])];
    const raced = makeDb([
      { data: [runRow()], error: null },
      { data: [flowRow("f1", steps)], error: null },
      { data: [], error: null } // revision-gated update matched nothing
    ]);
    expect(await applyGoalEvent(raced.db, BIZ, LEAD, { kind: "replied" })).toEqual({
      jumpedRuns: 0
    });
    expect(raced.calls.some((c) => c.name === "upsert")).toBe(false);

    const updateErr = makeDb([
      { data: [runRow()], error: null },
      { data: [flowRow("f1", steps)], error: null },
      { data: null, error: { message: "update down" } }
    ]);
    expect(await applyGoalEvent(updateErr.db, BIZ, LEAD, { kind: "replied" })).toEqual({
      jumpedRuns: 0
    });

    // A null update page (no error, no rows) is treated as a lost race too.
    const nullUpdate = makeDb([
      { data: [runRow()], error: null },
      { data: [flowRow("f1", steps)], error: null },
      { data: null, error: null }
    ]);
    expect(await applyGoalEvent(nullUpdate.db, BIZ, LEAD, { kind: "replied" })).toEqual({
      jumpedRuns: 0
    });
    err.mockRestore();
  });

  it("a skip-row upsert failure still counts the jump (history sparse, state right)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const steps = [sms("s0"), sms("s1"), goal("g1", [{ kind: "tag_added", tag: "Won" }])];
    const { db } = makeDb([
      { data: [runRow({ current_step: 0 })], error: null },
      { data: [flowRow("f1", steps)], error: null },
      { data: [{ id: "r1" }], error: null },
      { data: null, error: { message: "steps down" } }, // s0 skip fails
      { data: null, error: null } // s1 skip lands
    ]);
    expect(await applyGoalEvent(db, BIZ, LEAD, { kind: "tag_added", tag: "Won" })).toEqual({
      jumpedRuns: 1
    });
    err.mockRestore();
  });

  it("jumps multiple runs independently (one lost race does not block the next)", async () => {
    const steps = [sms("s0"), goal("g1", [{ kind: "claimed" }])];
    const { db } = makeDb([
      // r2 carries a null context: the jump must still work (vars default {}).
      { data: [runRow(), runRow({ id: "r2", context: null })], error: null },
      { data: [flowRow("f1", steps)], error: null },
      { data: [], error: null }, // r1 lost the race
      { data: [{ id: "r2" }], error: null }, // r2 jump landed
      { data: null, error: null } // r2 skip row
    ]);
    expect(await applyGoalEvent(db, BIZ, LEAD, { kind: "claimed" })).toEqual({ jumpedRuns: 1 });
  });
});

/**
 * A KEYED delivery, for the one caller that can retry the same milestone: the
 * segment-action sweep announces before it persists the tag, so a night that
 * dies mid-write re-announces the next night. The key names the tag
 * APPLICATION, so the retry has to recognise the work the first attempt did.
 */
describe("applyGoalEvent with a dedupeKey (a retryable delivery)", () => {
  const KEY = "ce:segact:seg-1:c1:won";
  // Pinned literally: this is the mark a later night looks for.
  const KEY_VAR = "__goal_evt_ce:segact:seg-1:c1:won";
  const WON = { kind: "tag_added", tag: "Won", dedupeKey: KEY } as const;

  it("stamps the key on the run it fast-forwards", async () => {
    const steps = [sms("s0"), sms("s1"), goal("g1", [{ kind: "tag_added", tag: "Won" }])];
    const { db, calls } = makeDb([
      { data: [runRow()], error: null },
      { data: [flowRow("f1", steps)], error: null },
      { data: [{ id: "r1" }], error: null }, // jump landed
      { data: null, error: null }, // s0 skip row
      { data: null, error: null } // s1 skip row
    ]);
    expect(await applyGoalEvent(db, BIZ, LEAD, WON)).toEqual({ jumpedRuns: 1 });
    const update = calls.find((c) => c.name === "update" && c.table === "ai_flow_runs")!
      .args[0] as Record<string, unknown>;
    const ctx = update.context as { vars: Record<string, unknown> };
    // Same update as the jump, so the mark and the jump share fate.
    expect(ctx.vars[KEY_VAR]).toBe("tag_added");
    expect(ctx.vars[goalReachedVar("g1")]).toBe("tag_added");
  });

  it("a retry leaves a run it already jumped alone, even with a later goal on the same tag", async () => {
    // The exact hazard: night one jumped the run to g1 and then died before
    // the tag column landed. Night two re-announces the same application, and
    // without the mark it would fast-forward the run AGAIN, this time to g2,
    // skipping every follow-up in between.
    const steps = [
      sms("s0"),
      goal("g1", [{ kind: "tag_added", tag: "Won" }]),
      sms("s2"),
      goal("g2", [{ kind: "tag_added", tag: "Won" }])
    ];
    const jumped = runRow({
      current_step: 1,
      context: {
        vars: { [goalReachedVar("g1")]: "tag_added", [KEY_VAR]: "tag_added" },
        trigger: { from: LEAD }
      }
    });
    const retry = makeDb([
      { data: [jumped], error: null },
      { data: [flowRow("f1", steps)], error: null }
    ]);
    expect(await applyGoalEvent(retry.db, BIZ, LEAD, WON)).toEqual({ jumpedRuns: 0 });
    expect(retry.calls.some((c) => c.name === "update")).toBe(false);

    // Opt-in only: an unkeyed delivery (every other caller) is unchanged, and
    // that is what makes the run above jumpable in the first place.
    const unkeyed = makeDb([
      { data: [jumped], error: null },
      { data: [flowRow("f1", steps)], error: null },
      { data: [{ id: "r1" }], error: null },
      { data: null, error: null }, // g1 skip row
      { data: null, error: null } // s2 skip row
    ]);
    expect(
      await applyGoalEvent(unkeyed.db, BIZ, LEAD, { kind: "tag_added", tag: "Won" })
    ).toEqual({ jumpedRuns: 1 });
    const update = unkeyed.calls.find((c) => c.name === "update" && c.table === "ai_flow_runs")!
      .args[0] as Record<string, unknown>;
    expect(update.current_step).toBe(3);
  });

  it("never jumps a run its own enqueue created, and only that run", async () => {
    // The contact-event enqueue stores the same key on the run it inserts. On
    // a repair night that run already exists, and a flow started BY this tag
    // has to play its own steps, not be jumped past them by the event that
    // started it.
    const steps = [sms("s0"), goal("g1", [{ kind: "tag_added", tag: "Won" }])];
    const { db, calls } = makeDb([
      {
        data: [
          runRow({ id: "rEnqueued", dedupe_key: KEY }),
          // A different run for the same lead, untouched by night one.
          runRow({ id: "rOther", context: null })
        ],
        error: null
      },
      { data: [flowRow("f1", steps)], error: null },
      { data: [{ id: "rOther" }], error: null }, // rOther jump landed
      { data: null, error: null } // rOther skip row
    ]);
    expect(await applyGoalEvent(db, BIZ, LEAD, WON)).toEqual({ jumpedRuns: 1 });
    const updates = calls.filter((c) => c.name === "eq" && c.table === "ai_flow_runs");
    expect(updates.some((c) => c.args[1] === "rEnqueued")).toBe(false);
    expect(updates.some((c) => c.args[1] === "rOther")).toBe(true);
  });
});
