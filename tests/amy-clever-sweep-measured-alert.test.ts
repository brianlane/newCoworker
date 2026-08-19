import { describe, it, expect } from "vitest";
import {
  NEW_LABEL,
  NEW_QUESTION,
  buildMeasuredAlert,
  measuredAlertMessage
} from "../scripts/oneshot/amy-clever-sweep-measured-alert-definition";
import {
  ALERT_NOTIFY_ID,
  ALERT_STEP_ID,
  FITS_STEP_ID,
  REMAINDER_STEP_ID,
  SWEEP_CAPACITY,
  capacityAlertMessage
} from "../scripts/oneshot/amy-clever-weekly-update-sweep-definition";
import { parseAiFlowDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";

/**
 * Pins the alert repoint that rides the chained-sweep engine change.
 *
 * On 2026-08-19 the weekly sweep's first real run proved the old arithmetic
 * wrong in both directions: Clever stated 41 deals, one capped pass attempted
 * 6 and landed 2 (three cards timed out on Submit Update, one card had no
 * Provide Update control), and the alert texted "about 35 still need you"
 * because it assumed the pass had covered 6. With chaining, the same
 * arithmetic would over-alert instead: the loop drains the whole backlog and
 * "41 minus 6" would still page Amy about 35 phantom cards. The alert has to
 * read what the sweep measured, and stay silent when nothing is left.
 */

/** The live weekly sweep as of 2026-08-19 (read from the ai_flows row). */
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
    options: { suppressDefaultReply: true, captureStepScreenshots: false },
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
            valueTemplate:
              "Weekly update posted automatically by Amy's assistant. This client is active and in ongoing follow-up by phone, text, and email."
          },
          { kind: "click_text", target: "Submit Update" }
        ],
        forEachLink: 'section[data-sentry-component="InfiniteList"]:first-of-type a.clickable-card'
      },
      {
        id: "backlog",
        type: "extract_text",
        fields: [
          {
            name: "active_deal_count",
            description:
              'The number of active deals awaiting an update stated in the message, e.g. "29" from ' +
              '"29 Active Deals awaiting update". Digits only, no words. If the message states no ' +
              "number, return an empty string."
          }
        ]
      },
      {
        id: FITS_STEP_ID,
        type: "math",
        operation: "less_than",
        left: "{{vars.active_deal_count}}",
        right: String(SWEEP_CAPACITY + 1),
        saveAs: "sweep_fits"
      },
      {
        id: REMAINDER_STEP_ID,
        type: "math",
        operation: "subtract",
        left: "{{vars.active_deal_count}}",
        right: String(SWEEP_CAPACITY),
        saveAs: "deals_left"
      },
      {
        id: ALERT_STEP_ID,
        type: "branch",
        question: "Did the automated sweep cover the whole backlog Clever asked for?",
        branches: [
          {
            id: "over_capacity",
            label: "more deals than one pass can update",
            condition: { var: "sweep_fits", equals: "no" },
            steps: [
              {
                id: ALERT_NOTIFY_ID,
                type: "notify_owner",
                message: capacityAlertMessage()
              }
            ]
          }
        ],
        else: []
      }
    ]
  } as unknown as AiFlowDefinition;
}

describe("buildMeasuredAlert", () => {
  it("repoints the fits check at the measured left count", () => {
    const { definition, changes, issues } = buildMeasuredAlert(liveWeekly());
    expect(issues).toEqual([]);
    const fits = definition.steps.find((s) => s.id === FITS_STEP_ID) as unknown as {
      left: string;
      right: string;
      operation: string;
    };
    expect(fits.left).toBe("{{vars.update_each_left}}");
    expect(fits.right).toBe("1");
    expect(fits.operation).toBe("less_than");
    expect(changes.some((c) => c.includes(FITS_STEP_ID))).toBe(true);
  });

  it("removes the subtract step nothing consumes anymore", () => {
    const { definition } = buildMeasuredAlert(liveWeekly());
    expect(definition.steps.some((s) => s.id === REMAINDER_STEP_ID)).toBe(false);
  });

  it("texts the measured totals, not backlog arithmetic", () => {
    const { definition } = buildMeasuredAlert(liveWeekly());
    const branch = definition.steps.find((s) => s.id === ALERT_STEP_ID) as unknown as {
      question: string;
      branches: Array<{ label: string; steps: Array<{ id: string; message: string }> }>;
    };
    expect(branch.question).toBe(NEW_QUESTION);
    expect(branch.branches[0].label).toBe(NEW_LABEL);
    const message = branch.branches[0].steps[0].message;
    expect(message).toBe(measuredAlertMessage("update_each_updated", "update_each_left"));
    expect(message).toContain("{{vars.update_each_updated}}");
    expect(message).toContain("{{vars.update_each_left}}");
    expect(message).toContain("{{vars.active_deal_count}}");
    expect(message).toContain("{{vars.portal_url}}");
    // The whole point: no capacity constant baked into what Amy reads.
    expect(message).not.toContain(String(SWEEP_CAPACITY));
  });

  it("produces a definition the authoring validator accepts", () => {
    // This is the proof the measured vars are registered: the validator
    // rejects any {{vars.x}} no earlier step produces.
    const { definition } = buildMeasuredAlert(liveWeekly());
    expect(() => parseAiFlowDefinition(definition)).not.toThrow();
  });

  it("is idempotent: a second run reports nothing to change", () => {
    const once = buildMeasuredAlert(liveWeekly());
    const twice = buildMeasuredAlert(once.definition);
    expect(twice.issues).toEqual([]);
    expect(twice.changes).toEqual([]);
    expect(twice.definition).toEqual(once.definition);
  });

  it("aborts with issues when the flow has no forEachLink sweep", () => {
    const def = liveWeekly();
    delete (def.steps[1] as unknown as { forEachLink?: string }).forEachLink;
    const { issues } = buildMeasuredAlert(def);
    expect(issues.some((i) => i.includes("forEachLink"))).toBe(true);
  });

  it("aborts with issues when the alert chain is missing", () => {
    const def = liveWeekly();
    def.steps = def.steps.filter((s) => s.id !== ALERT_STEP_ID && s.id !== FITS_STEP_ID);
    const { issues } = buildMeasuredAlert(def);
    expect(issues.some((i) => i.includes(FITS_STEP_ID))).toBe(true);
    expect(issues.some((i) => i.includes(ALERT_STEP_ID))).toBe(true);
  });

  it("never mutates the live definition it was given", () => {
    const live = liveWeekly();
    const before = JSON.parse(JSON.stringify(live));
    buildMeasuredAlert(live);
    expect(live).toEqual(before);
  });
});
