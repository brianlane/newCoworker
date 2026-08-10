import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "../src/lib/ai-flows/schema";
import { patchSpokeCheckForUnclaimedLeads } from "../scripts/oneshot/clever-spoke-check-unclaimed-patch";
import type { AiFlowDefinition } from "../src/lib/ai-flows/schema";

/**
 * The spoke check only ran on owner_assigned, so a lead nobody ever claimed
 * never entered it: on Aug 10 2026, 14 of Amy's 45 Clever-tagged contacts had
 * no owner, the oldest untouched for 25 days. The patch adds a tag_changed
 * trigger (which fires at acceptance, not at claim) and closes the
 * double-enrollment hole the second trigger would otherwise open.
 */

const TAG = "Clever";

/** A minimal stand-in with the live flow's trigger shape. */
function spokeCheckDef(over: Record<string, unknown> = {}): AiFlowDefinition {
  const def = {
    version: 1,
    trigger: {
      channel: "owner_assigned",
      conditions: [{ type: "contains", value: "clever", caseInsensitive: true }]
    },
    steps: [{ id: "grace", type: "sleep", minutes: 4320 }],
    ...over
  };
  return parseAiFlowDefinition(def);
}

describe("patchSpokeCheckForUnclaimedLeads", () => {
  it("adds the tag_changed trigger and the re-entry gate, keeping owner_assigned", () => {
    const { next, changes } = patchSpokeCheckForUnclaimedLeads(spokeCheckDef(), {
      cleverTag: TAG
    });
    expect(changes).toHaveLength(2);

    // The original trigger survives: it still catches a manual owner pick,
    // which never writes the tag.
    expect((next as { trigger: { channel: string } }).trigger.channel).toBe("owner_assigned");

    const extras = (next as { triggers?: Array<Record<string, unknown>> }).triggers ?? [];
    expect(extras).toEqual([
      { channel: "tag_changed", tag: TAG, change: "added", conditions: [] }
    ]);

    // Without this, a lead that is tagged AND later claimed matches both
    // triggers and gets two parallel weekly-call chains.
    expect((next as { options?: { allowReentry?: boolean } }).options?.allowReentry).toBe(false);

    // The result is a definition the dashboard and CRUD API would accept.
    expect(() => parseAiFlowDefinition(next)).not.toThrow();
  });

  it("is idempotent: re-running reports nothing to do", () => {
    const once = patchSpokeCheckForUnclaimedLeads(spokeCheckDef(), { cleverTag: TAG }).next;
    const twice = patchSpokeCheckForUnclaimedLeads(once, { cleverTag: TAG });
    expect(twice.changes).toEqual([]);
    expect(twice.next).toBe(once);
  });

  it("recognizes an existing Clever trigger whatever its casing, and a defaulted change", () => {
    const already = spokeCheckDef({
      triggers: [{ channel: "tag_changed", tag: "clever", conditions: [] }],
      options: { allowReentry: false }
    });
    expect(patchSpokeCheckForUnclaimedLeads(already, { cleverTag: TAG }).changes).toEqual([]);
  });

  it("adds only the missing half when the flow already carries one of them", () => {
    const gated = spokeCheckDef({ options: { allowReentry: false } });
    expect(patchSpokeCheckForUnclaimedLeads(gated, { cleverTag: TAG }).changes).toEqual([
      `added tag_changed trigger on "${TAG}" (change=added)`
    ]);

    const triggered = spokeCheckDef({
      triggers: [{ channel: "tag_changed", tag: TAG, change: "added", conditions: [] }]
    });
    expect(patchSpokeCheckForUnclaimedLeads(triggered, { cleverTag: TAG }).changes).toEqual([
      "set options.allowReentry=false (blocks double enrollment)"
    ]);
  });

  it("preserves unrelated options and unrelated extra triggers", () => {
    const withOthers = spokeCheckDef({
      options: { allowReentry: true, quietHours: undefined },
      triggers: [{ channel: "contact_created", conditions: [] }]
    });
    const { next } = patchSpokeCheckForUnclaimedLeads(withOthers, { cleverTag: TAG });
    const extras = (next as { triggers: Array<{ channel: string }> }).triggers;
    expect(extras.map((t) => t.channel)).toEqual(["contact_created", "tag_changed"]);
    expect((next as { options: { allowReentry: boolean } }).options.allowReentry).toBe(false);
  });

  it("refuses a flow that is not the spoke check rather than guessing", () => {
    const wrong = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [{ id: "s", type: "sleep", minutes: 5 }]
    });
    expect(() => patchSpokeCheckForUnclaimedLeads(wrong, { cleverTag: TAG })).toThrow(
      /expected the primary trigger to be owner_assigned/
    );
  });

  it("refuses to silently drop a trigger when the extra slots are full", () => {
    const full = spokeCheckDef({
      triggers: [
        { channel: "contact_created", conditions: [] },
        { channel: "birthday", conditions: [] },
        { channel: "tag_changed", tag: "Other", change: "added", conditions: [] },
        { channel: "tag_changed", tag: "Third", change: "removed", conditions: [] }
      ]
    });
    expect(() => patchSpokeCheckForUnclaimedLeads(full, { cleverTag: TAG })).toThrow(
      /already carries 4 extra triggers/
    );
  });
});
