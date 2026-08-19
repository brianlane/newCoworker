import { describe, it, expect } from "vitest";
import {
  REMINDER_AMPM,
  REMINDER_AMPM_SELECT,
  REMINDER_DATE_INPUT,
  REMINDER_DATE_TEMPLATE,
  REMINDER_HOUR,
  REMINDER_HOUR_SELECT,
  REMINDER_MINUTES,
  REMINDER_MINUTES_SELECT,
  REMINDER_PICK_BUTTON,
  addWeeklyReminder,
  buildWithReminder,
  reminderActions
} from "../scripts/oneshot/amy-referralexchange-weekly-reminder-definition";
import { parseAiFlowDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";

/**
 * Pins the recurring ReferralExchange update.
 *
 * A `schedule` trigger produces no URL and `browse_action.urlVar` takes no
 * literal, so a scheduled portal write is not expressible. RE's own "Schedule
 * text reminder" is the only mechanism that can drive one, and its controls
 * (read live 2026-08-18) are a native date input plus three selects.
 */

const SUBMIT = ".update-status-container .submit.action-details button";

/** The live shape after the honesty gate: re_update in `else`, two armed twins. */
function liveish(): AiFlowDefinition {
  const updateActions = (status: string) => [
    { kind: "click_text", target: "Leave an update" },
    { kind: "click_text", target: status },
    { kind: "fill_selector", target: 'textarea[name="message"]', valueTemplate: "note" },
    { kind: "click_selector", target: SUBMIT }
  ];
  return {
    version: 1,
    trigger: { channel: "sms", correlationWindowMinutes: 15, conditions: [{ type: "has_url" }] },
    steps: [
      { id: "url", type: "extract_url", saveAs: "leadUrl" },
      {
        id: "browse",
        type: "browse_extract",
        urlVar: "leadUrl",
        auth: { integrationLabel: "Referral Exchange" },
        fields: [{ name: "lead_type", description: "buyer or seller" }]
      },
      {
        id: "re_update_gate",
        type: "branch",
        question: "Did this run reach the client?",
        branches: [
          {
            id: "re_upd_answered",
            label: "answered",
            condition: { var: "lead_type", equals: "seller" },
            steps: [
              {
                id: "re_update_spoke",
                type: "browse_action",
                urlVar: "leadUrl",
                auth: { integrationLabel: "Referral Exchange" },
                actions: updateActions("We are in contact")
              }
            ]
          }
        ],
        else: [
          {
            id: "re_update",
            type: "browse_action",
            urlVar: "leadUrl",
            auth: { integrationLabel: "Referral Exchange" },
            actions: updateActions("No interaction yet")
          }
        ]
      },
      { id: "notify", type: "notify_owner", message: "done" }
    ]
  } as unknown as AiFlowDefinition;
}

function stepById(def: AiFlowDefinition, id: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  const walk = (steps: readonly unknown[]): void => {
    for (const s of steps as Array<Record<string, unknown>>) {
      if (s.id === id) found = s;
      for (const arm of (s.branches as Array<{ steps?: unknown[] }>) ?? []) walk(arm.steps ?? []);
      walk((s.else as unknown[]) ?? []);
    }
  };
  walk(def.steps);
  return found;
}
const actionsOf = (def: AiFlowDefinition, id: string) =>
  (stepById(def, id) as { actions: Array<Record<string, string>> }).actions;

describe("the reminder controls", () => {
  it("targets RE's native date input, not a calendar widget to walk", () => {
    expect(REMINDER_DATE_INPUT).toBe('input[name="reminderDate"]');
    const fill = reminderActions().find((a) => a.target === REMINDER_DATE_INPUT);
    expect(fill?.kind).toBe("fill_selector");
  });

  it("renders a date in the YYYY-MM-DD form the input's pattern demands", () => {
    // The input declares pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"; {{now.in7Days.iso}}
    // is the only now-scope key that produces exactly that.
    expect(REMINDER_DATE_TEMPLATE).toBe("{{now.in7Days.iso}}");
    expect(REMINDER_DATE_TEMPLATE).toContain("in7Days");
  });

  it("schedules 9:00 AM, using the option values the selects actually offer", () => {
    // reminderHour offers 1..12 (not 09), reminderMinutes offers 00/15/30/45.
    expect(REMINDER_HOUR).toBe("9");
    expect(["00", "15", "30", "45"]).toContain(REMINDER_MINUTES);
    expect(["AM", "PM"]).toContain(REMINDER_AMPM);
  });

  it("picks a date rather than a same-day preset", () => {
    // "Tomorrow morning"/"Tomorrow afternoon" are one click each, but would text
    // Amy about every open referral EVERY DAY.
    expect(REMINDER_PICK_BUTTON).toBe("#reminder-selector");
    const json = JSON.stringify(reminderActions());
    expect(json).not.toContain("tomorrowMorning");
    expect(json).not.toContain("tomorrowAfternoon");
  });

  it("sets every field the reminder needs and nothing else", () => {
    expect(reminderActions().map((a) => a.target)).toEqual([
      REMINDER_PICK_BUTTON,
      REMINDER_DATE_INPUT,
      REMINDER_HOUR_SELECT,
      REMINDER_MINUTES_SELECT,
      REMINDER_AMPM_SELECT
    ]);
  });
});

describe("addWeeklyReminder", () => {
  it("reaches the armed twin inside a branch as well as the trunk fallback", () => {
    const def = liveish();
    expect(addWeeklyReminder(def).sort()).toEqual(["re_update", "re_update_spoke"]);
  });

  it("inserts the reminder BEFORE the submit that commits it", () => {
    const def = liveish();
    addWeeklyReminder(def);
    const kinds = actionsOf(def, "re_update").map((a) => a.target);
    expect(kinds.indexOf(REMINDER_PICK_BUTTON)).toBeLessThan(kinds.indexOf(SUBMIT));
    expect(kinds.at(-1)).toBe(SUBMIT);
  });

  it("leaves the status and the note ahead of it untouched", () => {
    const def = liveish();
    addWeeklyReminder(def);
    const list = actionsOf(def, "re_update");
    expect(list[0]).toEqual({ kind: "click_text", target: "Leave an update" });
    expect(list[1]).toEqual({ kind: "click_text", target: "No interaction yet" });
    expect(list[2].kind).toBe("fill_selector");
  });

  it("keeps each arm's own status, so the honesty gate still holds", () => {
    const def = liveish();
    addWeeklyReminder(def);
    expect(actionsOf(def, "re_update_spoke")[1].target).toBe("We are in contact");
    expect(actionsOf(def, "re_update")[1].target).toBe("No interaction yet");
  });

  it("is idempotent, so a re-run cannot stack five more actions", () => {
    const def = liveish();
    addWeeklyReminder(def);
    const before = actionsOf(def, "re_update").length;
    expect(addWeeklyReminder(def)).toEqual([]);
    expect(actionsOf(def, "re_update")).toHaveLength(before);
  });

  it("ignores steps with no RE submit, so unrelated browse steps are safe", () => {
    const def = liveish();
    (def.steps as unknown as Array<Record<string, unknown>>).push({
      id: "other",
      type: "browse_action",
      urlVar: "leadUrl",
      actions: [{ kind: "click_text", target: "Something else" }]
    });
    expect(addWeeklyReminder(def)).not.toContain("other");
  });

  it("stays inside the 15-action cap", () => {
    const def = liveish();
    addWeeklyReminder(def);
    expect(actionsOf(def, "re_update").length).toBeLessThanOrEqual(15);
  });
});

describe("the whole transform", () => {
  it("produces a definition the authoring validator accepts", () => {
    expect(() => parseAiFlowDefinition(buildWithReminder(liveish()).definition)).not.toThrow();
  });

  it("does not mutate the live definition handed in", () => {
    const live = liveish();
    const snap = JSON.parse(JSON.stringify(live));
    buildWithReminder(live);
    expect(live).toEqual(snap);
  });
});
