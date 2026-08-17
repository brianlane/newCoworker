import { describe, it, expect } from "vitest";
import {
  ALERT_ARM_ID,
  ALERT_NOTIFY_ID,
  ALERT_STEP_ID,
  BACKLOG_STEP_ID,
  BACKLOG_VAR,
  capacityAlertMessage,
  CLEVER_SENDER,
  CLEVER_SENDER_TYPO,
  DAILY_NEEDLE,
  FITS_STEP_ID,
  FITS_VAR,
  REMAINDER_STEP_ID,
  REMAINDER_VAR,
  SWEEP_CAPACITY,
  WEEKLY_NEEDLE,
  WEEKLY_NOTE,
  addCapacityAlert,
  buildDaily,
  buildWeeklySweep,
  retargetDailyTrigger,
  retargetWeeklySweepTrigger,
  rewriteSweepNote,
  trunkStepIds
} from "../scripts/oneshot/amy-clever-weekly-update-sweep-definition";
import { MAX_TOTAL_STEPS, parseAiFlowDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";

/**
 * Pins the Clever weekly-sweep repair.
 *
 * The two fixtures below are the LIVE definitions as read from `ai_flows` on
 * 2026-08-17, trimmed of nothing. They are copied in verbatim on purpose: the
 * repo's seeders have drifted from the rows (the seeder still defaults to the
 * transposed sender), and this repo's standing rule is that the live flow is the
 * source of truth, not the builder that once produced it.
 */

/**
 * The eight actions both Clever update flows share, verified live Jun 2026.
 *
 * Built fresh per call, never shared. These builders mutate the definition in
 * place (that is the point: the applier hands them a live row and writes the
 * result back), so a single module-level array would be edited by the first
 * test that rewrites the note and every later fixture would start already
 * fixed. That silently turned an assertion about "what changed" into an
 * assertion about "what a previous test left behind".
 */
const updateActions = () => [
  { kind: "click_text", target: "Provide Update" },
  { kind: "click_text", target: "We Spoke" },
  {
    kind: "select_option",
    target: 'select[id="Did you schedule a time to meet in person?"]',
    valueTemplate: "No"
  },
  { kind: "click_selector", target: 'input[placeholder="Select a date and time"]' },
  {
    kind: "click_role",
    target: "option",
    valueTemplate:
      "Choose {{now.in7Days.weekday}}, {{now.in7Days.month}} {{now.in7Days.dayOrdinal}}, {{now.in7Days.year}}"
  },
  { kind: "click_role", target: "option", valueTemplate: "09:00" },
  {
    kind: "fill_placeholder",
    target: "Type additional details about this update",
    valueTemplate: "call, texted, and emailed"
  },
  { kind: "click_text", target: "Submit Update" }
];

const NEEDS_ACTION_SELECTOR =
  'section[data-sentry-component="InfiniteList"]:first-of-type a.clickable-card';

/** Live "Clever Update Leads" (dd46c457), the sweep that has never fired. */
function liveWeekly(): AiFlowDefinition {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 2,
      conditions: [
        { type: "from_matches", value: CLEVER_SENDER_TYPO },
        { type: "has_url" }
      ]
    },
    options: { suppressDefaultReply: true, captureStepScreenshots: false },
    steps: [
      { id: "url", type: "extract_url", saveAs: "portal_url" },
      {
        id: "update_each",
        type: "browse_action",
        urlVar: "portal_url",
        auth: { integrationLabel: "Clever" },
        actions: updateActions(),
        forEachLink: NEEDS_ACTION_SELECTOR
      }
    ]
  } as unknown as AiFlowDefinition;
}

/** Live "Clever Update Leads (Chris)" (db6da831), the daily named-lead flow. */
function liveDaily(): AiFlowDefinition {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 1,
      conditions: [
        { type: "from_matches", value: CLEVER_SENDER },
        { type: "has_url" }
      ]
    },
    options: { suppressDefaultReply: true, captureStepScreenshots: false },
    steps: [
      { id: "url", type: "extract_url", saveAs: "portal_url" },
      {
        id: "names",
        type: "extract_text",
        fields: [{ name: "lead_names", description: "Every lead name needing an update." }]
      },
      {
        id: "update_named",
        type: "browse_action",
        urlVar: "portal_url",
        auth: { integrationLabel: "Clever" },
        actions: updateActions(),
        forEachLink: NEEDS_ACTION_SELECTOR,
        forEachLinkMatchVar: "lead_names"
      }
    ]
  } as unknown as AiFlowDefinition;
}

/** The two real messages, quoted from `sms_inbound_jobs` (Aug 12 and Aug 16). */
const DAILY_MESSAGE =
  "Hi Amy!\n\nThis is Chris with Clever Real Estate. Here's a summary of the new customers you " +
  "received today:\n- Jose Cortez\n- Judith Echeverria\n- Matt C\n\nHave you been in touch with " +
  "them yet? Please log into your portal to provide an update!\nhttps://agents.listwithclever.com/x";
const WEEKLY_MESSAGE =
  "Hi Amy!\n\nThis is Chris with Clever Real Estate. We require weekly updates on all active " +
  "customers. This is your friendly reminder to update your portal! Here's a summary of what is " +
  "needed:\n - 29 Active Deals awaiting update\n\nPlease log into your portal to provide " +
  "updates!\nhttps://agents.listwithclever.com/y";

function conditionsOf(def: AiFlowDefinition) {
  // `FlowTrigger` is a union and only some channels carry `conditions`.
  const held = (def.trigger as { conditions?: unknown }).conditions;
  return (Array.isArray(held) ? held : []) as Array<{ type: string; value?: string }>;
}
function needlesOf(def: AiFlowDefinition): string[] {
  return conditionsOf(def)
    .filter((c) => c.type === "contains")
    .map((c) => String(c.value));
}
function senderOf(def: AiFlowDefinition): string | undefined {
  return conditionsOf(def).find((c) => c.type === "from_matches")?.value;
}
/** Does this trigger's needle set match a message? Mirrors `contains` semantics. */
function matches(def: AiFlowDefinition, message: string): boolean {
  return needlesOf(def).every((n) => message.toLowerCase().includes(n.toLowerCase()));
}

describe("the transposed sender, which is the whole bug", () => {
  it("differs from the real one only by a digit swap", () => {
    expect(CLEVER_SENDER_TYPO).not.toBe(CLEVER_SENDER);
    expect([...CLEVER_SENDER_TYPO].sort().join("")).toBe([...CLEVER_SENDER].sort().join(""));
  });

  it("is what the live sweep still carries, so the sweep matches nothing", () => {
    expect(senderOf(liveWeekly())).toBe(CLEVER_SENDER_TYPO);
  });
});

describe("retargetWeeklySweepTrigger", () => {
  it("points the sweep at the real sender and narrows it to the weekly message", () => {
    const def = liveWeekly();
    const changes = retargetWeeklySweepTrigger(def);
    expect(senderOf(def)).toBe(CLEVER_SENDER);
    expect(needlesOf(def)).toEqual([WEEKLY_NEEDLE]);
    expect(changes).toEqual([
      `from_matches ${CLEVER_SENDER_TYPO} -> ${CLEVER_SENDER}`,
      `+ contains "${WEEKLY_NEEDLE}"`
    ]);
  });

  it("keeps has_url, which is how the portal link reaches the browse step", () => {
    const def = liveWeekly();
    retargetWeeklySweepTrigger(def);
    expect(conditionsOf(def).some((c) => c.type === "has_url")).toBe(true);
  });

  it("is idempotent", () => {
    const def = liveWeekly();
    retargetWeeklySweepTrigger(def);
    expect(retargetWeeklySweepTrigger(def)).toEqual([]);
  });
});

describe("retargetDailyTrigger", () => {
  it("leaves the already-correct sender alone and only adds the needle", () => {
    const def = liveDaily();
    expect(retargetDailyTrigger(def)).toEqual([`+ contains "${DAILY_NEEDLE}"`]);
    expect(senderOf(def)).toBe(CLEVER_SENDER);
  });

  it("is idempotent", () => {
    const def = liveDaily();
    retargetDailyTrigger(def);
    expect(retargetDailyTrigger(def)).toEqual([]);
  });
});

describe("the two flows stop overlapping", () => {
  const weekly = buildWeeklySweep(liveWeekly()).definition;
  const daily = buildDaily(liveDaily()).definition;

  it("routes each real message to exactly one flow", () => {
    expect(matches(daily, DAILY_MESSAGE)).toBe(true);
    expect(matches(weekly, DAILY_MESSAGE)).toBe(false);

    expect(matches(weekly, WEEKLY_MESSAGE)).toBe(true);
    expect(matches(daily, WEEKLY_MESSAGE)).toBe(false);
  });

  it("both still listen to the one number Clever actually sends from", () => {
    expect(senderOf(weekly)).toBe(CLEVER_SENDER);
    expect(senderOf(daily)).toBe(CLEVER_SENDER);
  });

  it("would have matched nothing before the fix, which is the recorded history", () => {
    // The unfixed sweep listens to a number that has never sent Amy anything.
    expect(senderOf(liveWeekly())).not.toBe(CLEVER_SENDER);
    // And the unfixed daily flow swallows the weekly message, because its only
    // conditions are the sender and "has a URL", both of which the weekly text
    // satisfies. That is why 29 deals came back "0 of 0 succeeded, done".
    expect(matches(liveDaily(), WEEKLY_MESSAGE)).toBe(true);
  });

  it("uses short fragments, not whole sentences that a reword would break", () => {
    for (const needle of [DAILY_NEEDLE, WEEKLY_NEEDLE]) {
      expect(needle.length).toBeLessThanOrEqual(40);
      expect(needle).not.toMatch(/Clever Real Estate/i);
    }
  });
});

describe("rewriteSweepNote", () => {
  it("replaces the inherited per-lead claim", () => {
    const def = liveWeekly();
    expect(rewriteSweepNote(def)).toBe("call, texted, and emailed");
    const actions = (def.steps[1] as unknown as { actions: Array<Record<string, string>> }).actions;
    expect(actions.find((a) => a.kind === "fill_placeholder")?.valueTemplate).toBe(WEEKLY_NOTE);
  });

  it("is idempotent", () => {
    const def = liveWeekly();
    rewriteSweepNote(def);
    expect(rewriteSweepNote(def)).toBeNull();
  });

  it("says nothing that could be false for one lead in the pass", () => {
    // One shared string is posted onto EVERY card, so it must carry no claim
    // about a specific conversation. "We Spoke" is still clicked and still
    // overclaims; that needs the modal's verified option list, which needs a
    // working Clever session.
    expect(WEEKLY_NOTE).not.toMatch(/\bspoke\b|\bcalled\b|\btalked\b/i);
    expect(WEEKLY_NOTE).toMatch(/automatically/i);
  });

  it("leaves the other seven actions exactly as they were", () => {
    const def = liveWeekly();
    const before = JSON.parse(
      JSON.stringify((def.steps[1] as unknown as { actions: unknown[] }).actions)
    ) as Array<Record<string, string>>;
    rewriteSweepNote(def);
    const after = (def.steps[1] as unknown as { actions: Array<Record<string, string>> }).actions;
    expect(after.map((a) => `${a.kind}:${a.target}`)).toEqual(
      before.map((a) => `${a.kind}:${a.target}`)
    );
    expect(after.filter((a) => a.kind !== "fill_placeholder")).toEqual(
      before.filter((a) => a.kind !== "fill_placeholder")
    );
  });
});

describe("addCapacityAlert", () => {
  it("appends the read, the two comparisons, and the branch in that order", () => {
    const def = liveWeekly();
    const added = addCapacityAlert(def);
    expect(added).toEqual([BACKLOG_STEP_ID, FITS_STEP_ID, REMAINDER_STEP_ID, ALERT_STEP_ID]);
    expect(trunkStepIds(def)).toEqual([
      "url",
      "update_each",
      BACKLOG_STEP_ID,
      FITS_STEP_ID,
      REMAINDER_STEP_ID,
      ALERT_STEP_ID
    ]);
  });

  it("reports on a sweep that already ran, so a bad read cannot block the sweep", () => {
    const def = liveWeekly();
    addCapacityAlert(def);
    const ids = trunkStepIds(def);
    expect(ids.indexOf("update_each")).toBeLessThan(ids.indexOf(BACKLOG_STEP_ID));
  });

  it("produces the number BEFORE the steps that consume it", () => {
    const def = liveWeekly();
    addCapacityAlert(def);
    const ids = trunkStepIds(def);
    expect(ids.indexOf(BACKLOG_STEP_ID)).toBeLessThan(ids.indexOf(FITS_STEP_ID));
    expect(ids.indexOf(BACKLOG_STEP_ID)).toBeLessThan(ids.indexOf(REMAINDER_STEP_ID));
  });

  it("compares against capacity + 1, so a backlog exactly at capacity still fits", () => {
    const def = liveWeekly();
    addCapacityAlert(def);
    const fits = def.steps.find((s) => s.id === FITS_STEP_ID) as unknown as {
      operation: string;
      left: string;
      right: string;
      saveAs: string;
    };
    expect(fits.operation).toBe("less_than");
    expect(fits.left).toBe(`{{vars.${BACKLOG_VAR}}}`);
    expect(fits.right).toBe(String(SWEEP_CAPACITY + 1));
    expect(fits.saveAs).toBe(FITS_VAR);
  });

  it("alerts on 'no', which is the answer when the backlog did NOT fit", () => {
    const def = liveWeekly();
    addCapacityAlert(def);
    const branch = def.steps.find((s) => s.id === ALERT_STEP_ID) as unknown as {
      branches: Array<{ id: string; condition: { var: string; equals: string }; steps: Array<{ id: string; type: string }> }>;
      else: unknown[];
    };
    expect(branch.branches).toHaveLength(1);
    expect(branch.branches[0].id).toBe(ALERT_ARM_ID);
    expect(branch.branches[0].condition).toEqual({ var: FITS_VAR, equals: "no" });
    expect(branch.branches[0].steps.map((s) => s.id)).toEqual([ALERT_NOTIFY_ID]);
    expect(branch.branches[0].steps[0].type).toBe("notify_owner");
    // Backlog within capacity: nothing to say, so no text.
    expect(branch.else).toEqual([]);
  });

  it("subtracts capacity, not capacity + 1, when reporting the remainder", () => {
    const def = liveWeekly();
    addCapacityAlert(def);
    const rem = def.steps.find((s) => s.id === REMAINDER_STEP_ID) as unknown as {
      operation: string;
      right: string;
      saveAs: string;
    };
    expect(rem.operation).toBe("subtract");
    expect(rem.right).toBe(String(SWEEP_CAPACITY));
    expect(rem.saveAs).toBe(REMAINDER_VAR);
  });

  it("tells Amy the real numbers and hands her the portal link", () => {
    const message = capacityAlertMessage();
    expect(message).toContain(`{{vars.${BACKLOG_VAR}}}`);
    expect(message).toContain(`{{vars.${REMAINDER_VAR}}}`);
    expect(message).toContain("{{vars.portal_url}}");
    expect(message).toContain(String(SWEEP_CAPACITY));
  });

  it("quotes the capacity the math actually used, not the module default", () => {
    // Otherwise a caller-supplied capacity makes the gate, the remainder and
    // the sentence Amy reads disagree with each other. The alert exists to be
    // trusted, so this is the one number it must never get wrong.
    const def = liveWeekly();
    addCapacityAlert(def, 10);
    const branch = def.steps.find((s) => s.id === ALERT_STEP_ID) as unknown as {
      branches: Array<{ steps: Array<{ message: string }> }>;
    };
    const message = branch.branches[0].steps[0].message;
    expect(message).toContain("cover 10 in one pass");
    expect(message).not.toContain(`cover ${SWEEP_CAPACITY} in one pass`);
  });

  it("is idempotent, so re-running the one-shot cannot stack duplicate alerts", () => {
    const def = liveWeekly();
    addCapacityAlert(def);
    const after = trunkStepIds(def);
    expect(addCapacityAlert(def)).toEqual([]);
    expect(trunkStepIds(def)).toEqual(after);
  });

  it("honors a caller-supplied capacity in both the gate and the remainder", () => {
    const def = liveWeekly();
    addCapacityAlert(def, 10);
    const fits = def.steps.find((s) => s.id === FITS_STEP_ID) as unknown as { right: string };
    const rem = def.steps.find((s) => s.id === REMAINDER_STEP_ID) as unknown as { right: string };
    expect(fits.right).toBe("11");
    expect(rem.right).toBe("10");
  });

  it("does not re-add a backlog read the flow already has", () => {
    const def = liveWeekly();
    def.steps.push({
      id: BACKLOG_STEP_ID,
      type: "extract_text",
      fields: [{ name: BACKLOG_VAR, description: "already here" }]
    } as unknown as (typeof def.steps)[number]);
    const added = addCapacityAlert(def);
    expect(added).not.toContain(BACKLOG_STEP_ID);
    expect(def.steps.filter((s) => s.id === BACKLOG_STEP_ID)).toHaveLength(1);
  });
});

describe("the whole transform, as the applier will write it", () => {
  it("produces a definition the authoring validator accepts", () => {
    const { definition } = buildWeeklySweep(liveWeekly());
    expect(() => parseAiFlowDefinition(definition)).not.toThrow();
  });

  it("produces a valid daily definition too", () => {
    const { definition } = buildDaily(liveDaily());
    expect(() => parseAiFlowDefinition(definition)).not.toThrow();
  });

  it("does not mutate the live definition handed in", () => {
    const live = liveWeekly();
    const snapshot = JSON.parse(JSON.stringify(live));
    buildWeeklySweep(live);
    expect(live).toEqual(snapshot);
  });

  it("stays well inside the step cap", () => {
    const { definition } = buildWeeklySweep(liveWeekly());
    expect(definition.steps.length).toBeLessThan(MAX_TOTAL_STEPS);
  });

  it("summarizes every change it made, for the applier's pre-flight", () => {
    const { changes } = buildWeeklySweep(liveWeekly());
    expect(changes).toEqual([
      `from_matches ${CLEVER_SENDER_TYPO} -> ${CLEVER_SENDER}`,
      `+ contains "${WEEKLY_NEEDLE}"`,
      `note "call, texted, and emailed" -> "${WEEKLY_NOTE}"`,
      `+ steps ${BACKLOG_STEP_ID}, ${FITS_STEP_ID}, ${REMAINDER_STEP_ID}, ${ALERT_STEP_ID}`
    ]);
  });

  it("reports nothing to do on a second pass", () => {
    const once = buildWeeklySweep(liveWeekly()).definition;
    expect(buildWeeklySweep(once).changes).toEqual([]);
  });

  it("leaves the forEach selector and its cap-free shape untouched", () => {
    const { definition } = buildWeeklySweep(liveWeekly());
    const step = definition.steps.find((s) => s.id === "update_each") as unknown as {
      forEachLink: string;
      forEachLinkMatchVar?: string;
    };
    expect(step.forEachLink).toBe(NEEDS_ACTION_SELECTOR);
    // No name filter: the weekly sweep must touch EVERY card needing action,
    // which is the entire reason this flow exists separately from the daily one.
    expect(step.forEachLinkMatchVar).toBeUndefined();
  });
});
