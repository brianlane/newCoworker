import { describe, it, expect } from "vitest";
import {
  CLASSIFY_OPTIONS,
  CLASSIFY_SELECT_TARGET,
  CLASSIFY_VALUE,
  buildClassifySelect
} from "../scripts/oneshot/amy-clever-sweep-classify-select-definition";
import { parseAiFlowDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";

/**
 * Pins the classify-select insert that unblocked the chained weekly sweep.
 *
 * Run 5f6b1075 (2026-08-19) drained 6 of 34 cards and stopped at no_progress:
 * six distinct cards' update modals carry a REQUIRED
 * "How would you classify this customer?" select the flow never answered, so
 * Submit Update stayed disabled and those cards failed every pass. Cards
 * without the select must keep working too, hence optional: true.
 */

/** The live weekly sweep's browse step shape after the measured-alert patch. */
function liveWeekly(): AiFlowDefinition {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 2,
      conditions: [
        { type: "from_matches", value: "3142077635" },
        { type: "has_url" },
        { type: "contains", value: "awaiting update", caseInsensitive: true }
      ]
    },
    options: { suppressDefaultReply: true },
    steps: [
      { id: "url", type: "extract_url", saveAs: "portal_url" },
      {
        id: "update_each",
        type: "browse_action",
        urlVar: "portal_url",
        auth: { integrationLabel: "Clever" },
        actions: [
          { kind: "click_text", target: "Provide Update" },
          { kind: "click_text", target: "No Status Change" },
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
            valueTemplate: "Weekly update posted automatically by Amy's assistant."
          },
          { kind: "click_text", target: "Submit Update" }
        ],
        forEachLink: 'section[data-sentry-component="InfiniteList"]:first-of-type a.clickable-card'
      }
    ]
  } as unknown as AiFlowDefinition;
}

function sweepActions(def: AiFlowDefinition): Array<Record<string, unknown>> {
  return (def.steps[1] as unknown as { actions: Array<Record<string, unknown>> }).actions;
}

describe("buildClassifySelect", () => {
  it("inserts the optional select immediately before Submit Update", () => {
    const { definition, changes, issues } = buildClassifySelect(liveWeekly());
    expect(issues).toEqual([]);
    expect(changes).toHaveLength(1);
    const actions = sweepActions(definition);
    const at = actions.findIndex((a) => a.target === CLASSIFY_SELECT_TARGET);
    expect(at).toBeGreaterThan(0);
    expect(actions[at]).toEqual({
      kind: "select_option",
      target: CLASSIFY_SELECT_TARGET,
      valueTemplate: CLASSIFY_VALUE,
      optional: true
    });
    expect(actions[at + 1]).toMatchObject({ kind: "click_text", target: "Submit Update" });
  });

  it("answers with a value the modal actually offers", () => {
    expect(CLASSIFY_OPTIONS).toContain(CLASSIFY_VALUE);
  });

  it("produces a definition the authoring validator accepts", () => {
    const { definition } = buildClassifySelect(liveWeekly());
    expect(() => parseAiFlowDefinition(definition)).not.toThrow();
  });

  it("is idempotent", () => {
    const once = buildClassifySelect(liveWeekly());
    const twice = buildClassifySelect(once.definition);
    expect(twice.changes).toEqual([]);
    expect(twice.issues).toEqual([]);
    expect(twice.definition).toEqual(once.definition);
  });

  it("refuses a flow with no Submit Update action", () => {
    const def = liveWeekly();
    (def.steps[1] as unknown as { actions: Array<Record<string, unknown>> }).actions = [
      { kind: "click_text", target: "Provide Update" }
    ];
    const { issues } = buildClassifySelect(def);
    expect(issues.some((i) => i.includes("Submit Update"))).toBe(true);
  });

  it("refuses a flow without exactly one forEachLink sweep", () => {
    const def = liveWeekly();
    delete (def.steps[1] as unknown as { forEachLink?: string }).forEachLink;
    const { issues } = buildClassifySelect(def);
    expect(issues.some((i) => i.includes("forEachLink"))).toBe(true);
  });

  it("never mutates the live definition it was given", () => {
    const live = liveWeekly();
    const before = JSON.parse(JSON.stringify(live));
    buildClassifySelect(live);
    expect(live).toEqual(before);
  });
});
