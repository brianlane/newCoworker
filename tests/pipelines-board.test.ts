import { describe, it, expect } from "vitest";
import { stageForTags, groupCardsByStage, isStageTag, type StageRef } from "@/lib/pipelines/board";
import { computeStageMove } from "@/lib/pipelines/move";
import {
  normalizeStageColor,
  DEFAULT_PIPELINE,
  MAX_STAGES_PER_PIPELINE,
  STAGE_COLORS
} from "@/lib/pipelines/types";
import { MAX_CONTACT_TAGS } from "@/lib/customer-memory/types";

const STAGES: StageRef[] = [
  { id: "s1", name: "New Lead", position: 0 },
  { id: "s2", name: "Contacted", position: 1 },
  { id: "s3", name: "Won", position: 2 }
];

describe("stageForTags", () => {
  it("returns null when no tag matches a stage", () => {
    expect(stageForTags(STAGES, [])).toBeNull();
    expect(stageForTags(STAGES, ["VIP", "roof-2026"])).toBeNull();
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(stageForTags(STAGES, ["  new lead "])?.id).toBe("s1");
    expect(stageForTags(STAGES, ["CONTACTED"])?.id).toBe("s2");
  });

  it("picks the FURTHEST stage when several stage tags are present", () => {
    // A flow added "Contacted" without removing "New Lead": most-advanced wins.
    expect(stageForTags(STAGES, ["New Lead", "Contacted"])?.id).toBe("s2");
    expect(stageForTags(STAGES, ["Won", "New Lead"])?.id).toBe("s3");
  });

  it("is order-independent over the stage list", () => {
    const reversed = [...STAGES].reverse();
    expect(stageForTags(reversed, ["New Lead", "Contacted"])?.id).toBe("s2");
  });
});

describe("groupCardsByStage", () => {
  it("keys every stage (empty columns included) and drops off-board cards", () => {
    const cards = [
      { e164: "+1", tags: ["New Lead"] },
      { e164: "+2", tags: ["contacted", "VIP"] },
      { e164: "+3", tags: ["VIP"] }, // not on this pipeline
      { e164: "+4", tags: ["New Lead", "Won"] } // furthest stage wins
    ];
    const grouped = groupCardsByStage(STAGES, cards);
    expect([...grouped.keys()]).toEqual(["s1", "s2", "s3"]);
    expect(grouped.get("s1")!.map((c) => c.e164)).toEqual(["+1"]);
    expect(grouped.get("s2")!.map((c) => c.e164)).toEqual(["+2"]);
    expect(grouped.get("s3")!.map((c) => c.e164)).toEqual(["+4"]);
  });

  it("returns an empty map for a stageless pipeline", () => {
    expect(groupCardsByStage([], [{ tags: ["New Lead"] }]).size).toBe(0);
  });
});

describe("isStageTag", () => {
  it("matches stage names case-insensitively", () => {
    expect(isStageTag(STAGES, "new lead")).toBe(true);
    expect(isStageTag(STAGES, " WON ")).toBe(true);
    expect(isStageTag(STAGES, "VIP")).toBe(false);
  });
});

describe("computeStageMove", () => {
  const stageNames = STAGES.map((s) => s.name);

  it("swaps the current stage tag for the target, keeping other tags", () => {
    const delta = computeStageMove(["VIP", "New Lead"], stageNames, "Contacted");
    expect(delta.nextTags).toEqual(["VIP", "Contacted"]);
    expect(delta.added).toEqual(["Contacted"]);
    expect(delta.removed).toEqual(["New Lead"]);
    expect(delta.droppedAtCap).toBe(false);
  });

  it("strips EVERY stage tag of the pipeline, not just one", () => {
    const delta = computeStageMove(["New Lead", "Contacted", "VIP"], stageNames, "Won");
    expect(delta.nextTags).toEqual(["VIP", "Won"]);
    expect(delta.removed).toEqual(["New Lead", "Contacted"]);
  });

  it("is a no-op add when the contact is already in the target stage", () => {
    const delta = computeStageMove(["Contacted", "VIP"], stageNames, "contacted");
    expect(delta.nextTags).toEqual(["Contacted", "VIP"]);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
  });

  it("takes the contact off the board when target is null", () => {
    const delta = computeStageMove(["New Lead", "VIP"], stageNames, null);
    expect(delta.nextTags).toEqual(["VIP"]);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual(["New Lead"]);
  });

  it("treats a blank target like null and skips blank stage names", () => {
    const delta = computeStageMove(["New Lead"], ["", ...stageNames], "   ");
    expect(delta.nextTags).toEqual([]);
    expect(delta.removed).toEqual(["New Lead"]);
  });

  it("normalizes current tags: trims, clamps to 40 chars, de-dups case-insensitively", () => {
    const long = "x".repeat(50);
    const delta = computeStageMove(
      ["  VIP  ", "vip", "", long],
      stageNames,
      "New Lead"
    );
    expect(delta.nextTags).toEqual(["VIP", "x".repeat(40), "New Lead"]);
  });

  it("reports droppedAtCap when the 25-tag cap blocks the target", () => {
    const full = Array.from({ length: MAX_CONTACT_TAGS }, (_, i) => `tag-${i}`);
    const delta = computeStageMove(full, stageNames, "New Lead");
    expect(delta.nextTags).toEqual(full);
    expect(delta.added).toEqual([]);
    expect(delta.droppedAtCap).toBe(true);
  });
});

describe("pipeline types", () => {
  it("clamps colors onto the palette", () => {
    expect(normalizeStageColor("rose")).toBe("rose");
    expect(normalizeStageColor("hotpink")).toBe("teal");
    expect(normalizeStageColor(null)).toBe("teal");
    expect(normalizeStageColor(undefined)).toBe("teal");
  });

  it("ships a valid default pipeline (unique stage names, palette colors, under cap)", () => {
    const names = DEFAULT_PIPELINE.stages.map((s) => s.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(DEFAULT_PIPELINE.stages.length).toBeLessThanOrEqual(MAX_STAGES_PER_PIPELINE);
    for (const s of DEFAULT_PIPELINE.stages) {
      expect(STAGE_COLORS).toContain(s.color);
    }
    // The starter stages match the AiFlow builder's update_contact preset
    // ("New Lead" -> "Contacted") so existing automations land on the board.
    expect(DEFAULT_PIPELINE.stages.map((s) => s.name)).toContain("New Lead");
    expect(DEFAULT_PIPELINE.stages.map((s) => s.name)).toContain("Contacted");
  });
});
