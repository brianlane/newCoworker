import { describe, it, expect } from "vitest";
import {
  CLEVER_STATUSES,
  MEETING_SELECT_TARGET,
  STATUS_NO_CHANGE,
  STATUS_WE_SPOKE,
  buildSweep,
  switchToNoStatusChange
} from "../scripts/oneshot/amy-clever-sweep-no-status-change-definition";
import { parseAiFlowDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";

/**
 * Pins the "We Spoke" -> "No Status Change" fix.
 *
 * Clever's status list is a forward-only progression from the card's CURRENT
 * stage, read live 2026-08-18 on two cards: a card at "Tried Reaching Out"
 * offers "We Spoke", a card already at "Spoke" does not. The weekly sweep runs
 * over every active deal and most of Amy's book is past that point, so the
 * shipped sweep would have failed its second action on the majority of cards
 * and reported them as `failed` one by one.
 */

/** The live weekly sweep action list, as shipped before this fix. */
function liveSweep(): AiFlowDefinition {
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
          { kind: "click_text", target: STATUS_WE_SPOKE },
          { kind: "select_option", target: MEETING_SELECT_TARGET, valueTemplate: "No" },
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

function actions(def: AiFlowDefinition) {
  return (def.steps[1] as unknown as { actions: Array<Record<string, string>> }).actions;
}

describe("the status Clever actually offers", () => {
  it("puts No Status Change first, which is why it is on every card", () => {
    expect(CLEVER_STATUSES[0]).toBe(STATUS_NO_CHANGE);
  });

  it("records We Spoke as one option among nine, not the only one", () => {
    expect(CLEVER_STATUSES).toContain(STATUS_WE_SPOKE);
    expect(CLEVER_STATUSES).toHaveLength(9);
  });
});

describe("switchToNoStatusChange", () => {
  it("switches the status and drops the meeting select together", () => {
    const def = liveSweep();
    const changes = switchToNoStatusChange(def);
    expect(changes).toEqual([
      `status "${STATUS_WE_SPOKE}" -> "${STATUS_NO_CHANGE}"`,
      `- select_option "${MEETING_SELECT_TARGET}" (only exists under "${STATUS_WE_SPOKE}")`
    ]);
  });

  it("posts a status that exists on a card at ANY stage", () => {
    const def = liveSweep();
    switchToNoStatusChange(def);
    const clicked = actions(def).filter((a) => a.kind === "click_text").map((a) => a.target);
    expect(clicked).toContain(STATUS_NO_CHANGE);
    expect(clicked).not.toContain(STATUS_WE_SPOKE);
  });

  it("removes the select, because that control is never rendered on this path", () => {
    // Choosing "No Status Change" reveals only Notes and the follow-up date.
    // Leaving the select in would fail on every card.
    const def = liveSweep();
    switchToNoStatusChange(def);
    expect(actions(def).some((a) => a.kind === "select_option")).toBe(false);
    expect(actions(def)).toHaveLength(7);
  });

  it("keeps the date picker actions, which the portal still requires", () => {
    const def = liveSweep();
    switchToNoStatusChange(def);
    const kinds = actions(def).map((a) => `${a.kind}:${a.target}`);
    expect(kinds).toContain('click_selector:input[placeholder="Select a date and time"]');
    expect(actions(def).filter((a) => a.kind === "click_role")).toHaveLength(2);
  });

  it("keeps the note and the submit exactly where they were", () => {
    const def = liveSweep();
    switchToNoStatusChange(def);
    const list = actions(def);
    expect(list.at(-1)).toEqual({ kind: "click_text", target: "Submit Update" });
    expect(list.at(-2)?.kind).toBe("fill_placeholder");
  });

  it("still opens the modal first", () => {
    const def = liveSweep();
    switchToNoStatusChange(def);
    expect(actions(def)[0]).toEqual({ kind: "click_text", target: "Provide Update" });
  });

  it("is idempotent", () => {
    const def = liveSweep();
    switchToNoStatusChange(def);
    expect(switchToNoStatusChange(def)).toEqual([]);
  });

  it("leaves the trigger and the forEach selector untouched", () => {
    const def = liveSweep();
    const before = JSON.stringify({ t: def.trigger, f: (def.steps[1] as unknown as { forEachLink: string }).forEachLink });
    switchToNoStatusChange(def);
    expect(JSON.stringify({ t: def.trigger, f: (def.steps[1] as unknown as { forEachLink: string }).forEachLink })).toBe(before);
  });
});

describe("the whole transform", () => {
  it("produces a definition the authoring validator accepts", () => {
    expect(() => parseAiFlowDefinition(buildSweep(liveSweep()).definition)).not.toThrow();
  });

  it("does not mutate the live definition handed in", () => {
    const live = liveSweep();
    const snap = JSON.parse(JSON.stringify(live));
    buildSweep(live);
    expect(live).toEqual(snap);
  });

  it("stays within the 15-action cap with room to spare", () => {
    expect(actions(buildSweep(liveSweep()).definition).length).toBeLessThanOrEqual(15);
  });
});
