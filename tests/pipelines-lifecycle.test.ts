import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_STAGE_TAGS,
  planLifecycleStageWrites,
  MAX_STAGE_TAGS,
  MAX_STAGE_TAG_LENGTH,
  type PipelineStages,
  type StageRef
} from "../supabase/functions/_shared/pipelines/stages";
import { DEFAULT_PIPELINE } from "@/lib/pipelines/types";
import { MAX_CONTACT_TAGS, MAX_CONTACT_TAG_LENGTH } from "@/lib/customer-memory/types";

/** The default board: New Lead -> Contacted -> Engaged -> Booked -> Won. */
const DEFAULT_STAGES: StageRef[] = DEFAULT_PIPELINE.stages.map((s, i) => ({
  id: `s${i}`,
  name: s.name,
  position: i
}));

const leads = (stages: StageRef[] = DEFAULT_STAGES): PipelineStages => ({
  pipelineId: "p1",
  stages
});

describe("shared tag caps stay in lockstep with the platform ruleset", () => {
  // The _shared copy is inlined because the worker cannot import the `@/`
  // alias. These pin the two so a change to one fails loudly.
  it("matches src/lib/customer-memory/types", () => {
    expect(MAX_STAGE_TAGS).toBe(MAX_CONTACT_TAGS);
    expect(MAX_STAGE_TAG_LENGTH).toBe(MAX_CONTACT_TAG_LENGTH);
  });
});

describe("LIFECYCLE_STAGE_TAGS", () => {
  it("writes only default-board stages, and never Won", () => {
    // Won is a human judgement the board move endpoint owns; the platform must
    // never write it. Compared as a SET rather than a list, because moments and
    // stages are no longer one-to-one: `claimed` and `contacted` both mean the
    // lead has been reached and both write "Contacted".
    const defaults = DEFAULT_PIPELINE.stages.map((s) => s.name);
    const written = [...new Set(Object.values(LIFECYCLE_STAGE_TAGS))];
    expect([...written].sort()).toEqual([...defaults.slice(0, -1)].sort());
    expect(defaults.at(-1)).toBe("Won");
    expect(written).not.toContain("Won");
    // Every stage a moment writes has to be a real column on the default board,
    // since a stage IS a tag and an invented one is junk that still burns a slot.
    for (const tag of written) expect(defaults).toContain(tag);
  });

  it("covers the five lifecycle moments", () => {
    expect(Object.keys(LIFECYCLE_STAGE_TAGS)).toEqual([
      "lead_filed",
      "claimed",
      // We emailed them. A separate moment from `claimed` because it happens at
      // a different time from different code (the prospecting sweep, not a
      // teammate taking ownership), but the same stage: the board asks whether
      // anyone has touched this lead, not who did.
      "contacted",
      "replied",
      "booked"
    ]);
    expect(LIFECYCLE_STAGE_TAGS.contacted).toBe(LIFECYCLE_STAGE_TAGS.claimed);
  });
});

describe("planLifecycleStageWrites: the stage-must-exist gate", () => {
  it("writes nothing when the business has no pipeline at all", () => {
    const plan = planLifecycleStageWrites({
      event: "claimed",
      currentTags: ["Clever"],
      pipelines: []
    });
    expect(plan.changed).toBe(false);
    expect(plan.added).toEqual([]);
    expect(plan.nextTags).toEqual(["Clever"]);
    expect(plan.matchedPipelineIds).toEqual([]);
  });

  it("writes nothing when the pipeline lacks a stage for this moment", () => {
    // A tenant who renamed "Contacted" to "Working" opted out of that moment.
    const renamed = leads([
      { id: "a", name: "New Lead", position: 0 },
      { id: "b", name: "Working", position: 1 }
    ]);
    const plan = planLifecycleStageWrites({
      event: "claimed",
      currentTags: ["Clever"],
      pipelines: [renamed]
    });
    expect(plan.changed).toBe(false);
    expect(plan.nextTags).toEqual(["Clever"]);
  });

  it("still serves the moments the renamed board DOES carry", () => {
    const renamed = leads([
      { id: "a", name: "New Lead", position: 0 },
      { id: "b", name: "Working", position: 1 }
    ]);
    const plan = planLifecycleStageWrites({
      event: "lead_filed",
      currentTags: [],
      pipelines: [renamed]
    });
    expect(plan.added).toEqual(["New Lead"]);
  });

  it("matches the stage name case-insensitively", () => {
    const lower = leads([{ id: "a", name: "contacted", position: 0 }]);
    const plan = planLifecycleStageWrites({
      event: "claimed",
      currentTags: [],
      pipelines: [lower]
    });
    // The STAGE's own casing is what lands, not the canonical constant.
    expect(plan.added).toEqual(["contacted"]);
  });
});

describe("planLifecycleStageWrites: forward-only", () => {
  it("adds the stage to an untagged contact", () => {
    const plan = planLifecycleStageWrites({
      event: "lead_filed",
      currentTags: [],
      pipelines: [leads()]
    });
    expect(plan.changed).toBe(true);
    expect(plan.added).toEqual(["New Lead"]);
    expect(plan.removed).toEqual([]);
    expect(plan.nextTags).toEqual(["New Lead"]);
    expect(plan.matchedPipelineIds).toEqual(["p1"]);
  });

  it("promotes New Lead to Contacted and strips the old stage", () => {
    // The Donna Robinson case: Dave replied "1", so the claim advances her.
    const plan = planLifecycleStageWrites({
      event: "claimed",
      currentTags: ["Clever", "New Lead"],
      pipelines: [leads()]
    });
    expect(plan.added).toEqual(["Contacted"]);
    expect(plan.removed).toEqual(["New Lead"]);
    expect(plan.nextTags).toEqual(["Clever", "Contacted"]);
  });

  it("never drags a contact backwards", () => {
    for (const event of ["lead_filed", "claimed", "replied"] as const) {
      const plan = planLifecycleStageWrites({
        event,
        currentTags: ["Booked"],
        pipelines: [leads()]
      });
      expect(plan.changed).toBe(false);
      expect(plan.nextTags).toEqual(["Booked"]);
    }
  });

  it("is a no-op when the contact is already in the target stage", () => {
    // This is what makes a repeating trigger safe: every inbound text fires
    // `replied`, but only the first one transitions.
    const plan = planLifecycleStageWrites({
      event: "replied",
      currentTags: ["Engaged"],
      pipelines: [leads()]
    });
    expect(plan.changed).toBe(false);
    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([]);
  });

  it("advances from the FURTHEST stage a contact carries", () => {
    // A flow added Contacted without removing New Lead: booked still moves.
    const plan = planLifecycleStageWrites({
      event: "booked",
      currentTags: ["New Lead", "Contacted"],
      pipelines: [leads()]
    });
    expect(plan.added).toEqual(["Booked"]);
    expect(plan.removed).toEqual(["New Lead", "Contacted"]);
    expect(plan.nextTags).toEqual(["Booked"]);
  });
});

describe("planLifecycleStageWrites: non-stage tags", () => {
  it("leaves the tenant's own labels untouched", () => {
    const plan = planLifecycleStageWrites({
      event: "claimed",
      currentTags: ["Clever", "Needs Human", "Voice Capture"],
      pipelines: [leads()]
    });
    expect(plan.nextTags).toEqual([
      "Clever",
      "Needs Human",
      "Voice Capture",
      "Contacted"
    ]);
    expect(plan.removed).toEqual([]);
  });
});

describe("planLifecycleStageWrites: several pipelines", () => {
  it("composes into one tag set when both boards carry the stage", () => {
    const second: PipelineStages = {
      pipelineId: "p2",
      stages: [
        { id: "t1", name: "Contacted", position: 0 },
        { id: "t2", name: "Onboarded", position: 1 }
      ]
    };
    const plan = planLifecycleStageWrites({
      event: "claimed",
      currentTags: ["New Lead"],
      pipelines: [leads(), second]
    });
    // Both boards want "Contacted"; the second finds it already there.
    expect(plan.nextTags).toEqual(["Contacted"]);
    expect(plan.added).toEqual(["Contacted"]);
    expect(plan.matchedPipelineIds).toEqual(["p1"]);
  });

  it("moves each board independently when only one carries the stage", () => {
    const second: PipelineStages = {
      pipelineId: "p2",
      stages: [{ id: "t1", name: "Onboarded", position: 0 }]
    };
    const plan = planLifecycleStageWrites({
      event: "claimed",
      currentTags: ["Onboarded"],
      pipelines: [leads(), second]
    });
    expect(plan.added).toEqual(["Contacted"]);
    expect(plan.nextTags).toEqual(["Onboarded", "Contacted"]);
    expect(plan.matchedPipelineIds).toEqual(["p1"]);
  });
});

describe("planLifecycleStageWrites: the tag cap", () => {
  it("reports the cap and writes nothing at 25 non-stage tags", () => {
    const currentTags = Array.from({ length: MAX_STAGE_TAGS }, (_, i) => `t${i}`);
    const plan = planLifecycleStageWrites({
      event: "claimed",
      currentTags,
      pipelines: [leads()]
    });
    expect(plan.droppedAtCap).toBe(true);
    expect(plan.changed).toBe(false);
    expect(plan.nextTags).toEqual(currentTags);
  });

  it("a contact at the cap that already holds a stage tag still advances", () => {
    // Stripping the old stage tag frees exactly the slot the new one needs,
    // which is why the cap almost never blocks a real transition.
    const filler = Array.from({ length: MAX_STAGE_TAGS - 1 }, (_, i) => `t${i}`);
    const plan = planLifecycleStageWrites({
      event: "claimed",
      currentTags: [...filler, "New Lead"],
      pipelines: [leads()]
    });
    expect(plan.droppedAtCap).toBe(false);
    expect(plan.added).toEqual(["Contacted"]);
    expect(plan.removed).toEqual(["New Lead"]);
    expect(plan.nextTags).toHaveLength(MAX_STAGE_TAGS);
  });

  it("is not flagged when the move fits", () => {
    const plan = planLifecycleStageWrites({
      event: "claimed",
      currentTags: ["New Lead"],
      pipelines: [leads()]
    });
    expect(plan.droppedAtCap).toBe(false);
  });
});
