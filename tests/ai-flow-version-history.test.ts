import { describe, expect, it } from "vitest";
import { buildFlowHistory, describeEditSource } from "@/lib/ai-flows/version-history";
import type { AiFlowVersionRow } from "@/lib/ai-flows/versions";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

function def(message: string, extraStep?: boolean): AiFlowDefinition {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
    steps: [
      { id: "s1", type: "notify_owner", message },
      ...(extraStep ? [{ id: "s2", type: "notify_owner", message: "second" }] : [])
    ]
  } as unknown as AiFlowDefinition;
}

function version(over: Partial<AiFlowVersionRow> = {}): AiFlowVersionRow {
  return {
    id: 1,
    flow_id: "flow-1",
    business_id: "biz-1",
    definition: def("original"),
    name: "Lead follow-up",
    enabled: true,
    source: "dashboard",
    actor: "owner@example.com",
    replaced_at: "2026-08-18T04:00:00Z",
    ...over
  } as AiFlowVersionRow;
}

describe("describeEditSource", () => {
  it("names every surface that stamps an edit source", () => {
    expect(describeEditSource("dashboard")).toBe("Edited in the builder");
    expect(describeEditSource("dashboard_restore")).toBe("Restored from history");
    expect(describeEditSource("ai_edit")).toBe("Edited by your coworker");
    expect(describeEditSource("ai_edit_sms")).toBe("Edited by your coworker, by text");
    expect(describeEditSource("ai_edit_email")).toBe("Edited by your coworker, by email");
    expect(describeEditSource("ai_edit_slack")).toBe("Edited by your coworker, in Slack");
    expect(describeEditSource("ai_edit_dashboard")).toBe(
      "Edited by your coworker, in dashboard chat"
    );
    expect(describeEditSource("mcp")).toBe("Edited through a connected app");
    expect(describeEditSource("mcp_restore")).toBe("Restored through a connected app");
    expect(describeEditSource("white_glove")).toBe("Edited by the New Coworker team");
  });

  it("does not invent a source for an unstamped or unknown write", () => {
    // Every row written straight through PostgREST by a debug/ or oneshot
    // script is unstamped, as is anything from before the stamp existed. A
    // false attribution would be worse than an absent one.
    expect(describeEditSource(null)).toBe("An earlier change");
    expect(describeEditSource("some_future_surface")).toBe("An earlier change");
  });
});

describe("buildFlowHistory", () => {
  it("describes the newest snapshot against the LIVE definition", () => {
    // The rows only hold pre-edit states, so the most recent edit is only
    // visible by diffing the newest row against what is live right now.
    const entries = buildFlowHistory([version({ id: 9, definition: def("original") })], {
      name: "Lead follow-up",
      definition: def("reworded")
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].versionId).toBe(9);
    expect(entries[0].isMostRecent).toBe(true);
    expect(entries[0].by).toBe("Edited in the builder");
    expect(entries[0].actor).toBe("owner@example.com");
    expect(entries[0].changeSummary.join(" ")).toContain("original");
    expect(entries[0].changeSummary.join(" ")).toContain("reworded");
  });

  it("describes an older snapshot against the NEXT-NEWER one, not the live state", () => {
    // The off-by-one this module exists to own: row 1 (older) was replaced by
    // row 0's state, not by what is live two edits later.
    const entries = buildFlowHistory(
      [
        version({ id: 9, definition: def("middle"), replaced_at: "2026-08-18T06:00:00Z" }),
        version({ id: 8, definition: def("oldest"), replaced_at: "2026-08-18T04:00:00Z" })
      ],
      { name: "Lead follow-up", definition: def("newest") }
    );

    expect(entries.map((e) => e.versionId)).toEqual([9, 8]);
    expect(entries[0].changeSummary.join(" ")).toContain("newest");
    const older = entries[1].changeSummary.join(" ");
    expect(older).toContain("oldest");
    expect(older).toContain("middle");
    // The two-edits-later state must not leak into the older row's story.
    expect(older).not.toContain("newest");
    expect(entries[1].isMostRecent).toBe(false);
  });

  it("reports an added step and a rename", () => {
    const entries = buildFlowHistory([version({ id: 9, definition: def("original") })], {
      name: "Lead follow-up v2",
      definition: def("original", true)
    });

    const summary = entries[0].changeSummary.join(" ");
    expect(summary).toContain('Renames the automation to "Lead follow-up v2".');
    expect(summary).toContain("Adds 1 step: s2.");
  });

  it("reports no lines when the two states are equivalent", () => {
    // An enabled-only write still snapshots (the trigger fires on every
    // update), and diffFlowDefinitions would answer with its prospective
    // "Nothing would change." sentence, which is wrong for a past edit.
    const entries = buildFlowHistory([version({ id: 9, definition: def("same") })], {
      name: "Lead follow-up",
      definition: def("same")
    });

    expect(entries[0].changeSummary).toEqual([]);
  });

  it("returns nothing for a flow with no recorded history", () => {
    expect(buildFlowHistory([], { name: "Lead follow-up", definition: def("only") })).toEqual([]);
  });

  it("carries the snapshot's own name and timestamp, not the live flow's", () => {
    const entries = buildFlowHistory([version({ id: 9, name: "Old name" })], {
      name: "New name",
      definition: def("reworded")
    });

    expect(entries[0].name).toBe("Old name");
    expect(entries[0].replacedAt).toBe("2026-08-18T04:00:00Z");
  });
});
