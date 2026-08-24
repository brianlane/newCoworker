/**
 * The cadence learns the lead type instead of assuming it
 * (scripts/oneshot/amy-cadence-lead-type-from-note.ts).
 *
 * "Needs Follow Up (AI cadence)" runs off a tag_changed event, and that
 * event's text (name / phone / email / tags / source / tag / change / note)
 * never says whether someone is buying or selling. So the flow's written
 * default won every time: 42 of its first 42 runs answered "seller", which
 * made all three `route_buyer` branches unreachable and put buyer leads in
 * front of the seller trio. Sandy Baldwin (Aug 23 2026) was a ReferralExchange
 * BUYER whose parked run says seller.
 *
 * The upstream flows do know, so the tag carries it.
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_TAG_NOTE,
  FOLLOW_UP_TAG,
  READ_FIELDS,
  withLeadTypeNote
} from "../scripts/oneshot/amy-needs-follow-up-definition";
import {
  REREAD_FIELDS,
  applyLeadTypeNotes,
  applyReadFieldWording,
  declaresLeadType,
  followUpTagWriters,
  revertLeadTypeNotes,
  walkSteps
} from "../scripts/oneshot/amy-cadence-lead-type-from-note";

type Def = Record<string, unknown> & { steps: unknown[] };

/** Shaped like ReferralExchange Lead: extraction first, tag writers after. */
function leadFlow(): Def {
  return {
    version: 1,
    steps: [
      {
        id: "browse",
        type: "browse_extract",
        fields: [{ name: "lead_phone", description: "..." }, { name: "lead_type", description: "..." }]
      },
      { id: "tag_bare", type: "update_contact", addTags: [FOLLOW_UP_TAG] },
      {
        id: "tag_auto",
        type: "update_contact",
        addTags: [FOLLOW_UP_TAG],
        noteTemplate: AUTO_TAG_NOTE
      },
      {
        id: "gate",
        type: "branch",
        branches: [
          {
            id: "yes",
            steps: [{ id: "tag_nested", type: "update_contact", addTags: [FOLLOW_UP_TAG] }]
          }
        ],
        else: [{ id: "other_tag", type: "update_contact", addTags: ["Contacted"] }]
      }
    ]
  };
}

/** Shaped like Clever Lead - Accept: tags the lead, never establishes a type. */
function typelessFlow(): Def {
  return {
    version: 1,
    steps: [
      { id: "parse", type: "extract_text", fields: [{ name: "lead_phone", description: "..." }] },
      {
        id: "clever_tag",
        type: "update_contact",
        addTags: [FOLLOW_UP_TAG],
        noteTemplate: AUTO_TAG_NOTE
      }
    ]
  };
}

describe("withLeadTypeNote", () => {
  it("appends the marker on the SAME line, keeping the existing note intact", () => {
    // One `note:` line is all the event renders, so a newline would put the
    // type where the note label does not reach.
    const out = withLeadTypeNote(AUTO_TAG_NOTE);
    expect(out).toBe(`${AUTO_TAG_NOTE}; lead_type: {{vars.lead_type}}`);
    expect(out).not.toContain("\n");
  });

  it("preserves auto_first_contact verbatim, which round 1's call gate reads", () => {
    // `tag_auto` asks whether the note contains that exact phrase, and a "yes"
    // suppresses round 1's immediate call so the lead is not left two
    // voicemails in a row.
    expect(withLeadTypeNote(AUTO_TAG_NOTE)).toContain("auto_first_contact");
  });

  it("never INVENTS auto_first_contact for a note that had none", () => {
    // The opposite failure: a bare tag gaining that phrase would silently stop
    // a first call that used to happen.
    expect(withLeadTypeNote("")).toBe("lead_type: {{vars.lead_type}}");
    expect(withLeadTypeNote(undefined)).not.toContain("auto_first_contact");
    expect(withLeadTypeNote(null)).toBe("lead_type: {{vars.lead_type}}");
  });

  it("is idempotent, because the script that calls it is re-runnable", () => {
    const once = withLeadTypeNote(AUTO_TAG_NOTE);
    expect(withLeadTypeNote(once)).toBe(once);
    expect(withLeadTypeNote("  spaced note  ")).toBe("spaced note; lead_type: {{vars.lead_type}}");
  });

  it("can name a different source variable", () => {
    expect(withLeadTypeNote("", "route_lead_type")).toBe("lead_type: {{vars.route_lead_type}}");
  });
});

describe("walkSteps / declaresLeadType / followUpTagWriters", () => {
  it("reaches steps nested in branches and else-arms", () => {
    const ids = walkSteps(leadFlow().steps).map((s) => s.id);
    expect(ids).toContain("tag_nested");
    expect(ids).toContain("other_tag");
  });

  it("survives the junk a raw JSON definition can hold", () => {
    expect(walkSteps(undefined)).toEqual([]);
    expect(walkSteps("not an array")).toEqual([]);
    expect(walkSteps([null, "x", 7, { id: "ok", type: "noop" }]).map((s) => s.id)).toEqual(["ok"]);
    expect(walkSteps([{ id: "b", type: "branch", branches: [null, "x", { steps: null }] }])).toHaveLength(1);
  });

  it("finds only the writers that add THIS tag", () => {
    expect(followUpTagWriters(leadFlow()).map((s) => s.id)).toEqual([
      "tag_bare",
      "tag_auto",
      "tag_nested"
    ]);
    expect(followUpTagWriters({ steps: [{ id: "x", type: "update_contact" }] })).toEqual([]);
  });

  it("separates a flow that establishes a lead type from one that does not", () => {
    expect(declaresLeadType(leadFlow())).toBe(true);
    expect(declaresLeadType(typelessFlow())).toBe(false);
    expect(declaresLeadType({ steps: [{ id: "s", type: "extract_text", fields: "junk" }] })).toBe(
      false
    );
  });
});

describe("applyLeadTypeNotes", () => {
  it("marks every follow-up tag writer in a flow that knows the type", () => {
    const def = leadFlow();
    const changed = applyLeadTypeNotes(def);
    expect(changed).toHaveLength(3);
    const notes = followUpTagWriters(def).map((s) => s.noteTemplate);
    expect(notes).toEqual([
      "lead_type: {{vars.lead_type}}",
      `${AUTO_TAG_NOTE}; lead_type: {{vars.lead_type}}`,
      "lead_type: {{vars.lead_type}}"
    ]);
    // The tag writer for a DIFFERENT tag is untouched.
    const other = walkSteps(def.steps).find((s) => s.id === "other_tag");
    expect(other!.noteTemplate).toBeUndefined();
  });

  it("skips a flow that cannot know the type, rather than writing an empty marker", () => {
    // Clever leads arrive as a group text with no buy/sell record. Rendering
    // "lead_type: " with nothing after it would teach the cadence's extraction
    // that the answer is the empty string.
    const def = typelessFlow();
    expect(applyLeadTypeNotes(def)).toEqual([]);
    expect(followUpTagWriters(def)[0].noteTemplate).toBe(AUTO_TAG_NOTE);
  });

  it("reports no change on a second run", () => {
    const def = leadFlow();
    applyLeadTypeNotes(def);
    expect(applyLeadTypeNotes(def)).toEqual([]);
  });

  it("round-trips through revert", () => {
    const def = leadFlow();
    const before = JSON.parse(JSON.stringify(def));
    applyLeadTypeNotes(def);
    expect(revertLeadTypeNotes(def)).toHaveLength(3);
    expect(def).toEqual(before);
    // And a revert of an unpatched flow is a no-op, not a mangling.
    expect(revertLeadTypeNotes(def)).toEqual([]);
  });
});

describe("applyReadFieldWording", () => {
  const cadence = (): Def => ({
    version: 1,
    steps: [
      {
        id: "read_lead",
        type: "extract_text",
        fields: [
          { name: "lead_type", description: "stale: default seller" },
          { name: "lead_site", description: "stale: tags or text only" },
          { name: "lead_city", description: "untouched" },
          "junk"
        ]
      }
    ]
  });

  it("replaces exactly the named fields with the canonical wording", () => {
    const def = cadence();
    expect(applyReadFieldWording(def, REREAD_FIELDS)).toEqual([
      "read_lead.lead_type: description updated",
      "read_lead.lead_site: description updated"
    ]);
    const fields = walkSteps(def.steps)[0].fields as Array<Record<string, unknown>>;
    const want = (n: string) => READ_FIELDS.find((f) => f.name === n)!.description;
    expect(fields[0].description).toBe(want("lead_type"));
    expect(fields[1].description).toBe(want("lead_site"));
    expect(fields[2].description).toBe("untouched");
  });

  it("teaches the flow to prefer the note and the source line", () => {
    // The whole point: the fixed wording must actually point at where the
    // answers now live, or the one-shot is cosmetic.
    const want = (n: string) => READ_FIELDS.find((f) => f.name === n)!.description;
    expect(want("lead_type")).toContain("lead_type:");
    expect(want("lead_type")).toMatch(/only when nothing says/i);
    expect(want("lead_site")).toContain("source line");
  });

  it("is idempotent and tolerates a flow without the step", () => {
    const def = cadence();
    applyReadFieldWording(def, REREAD_FIELDS);
    expect(applyReadFieldWording(def, REREAD_FIELDS)).toEqual([]);
    expect(applyReadFieldWording({ steps: [] }, REREAD_FIELDS)).toEqual([]);
    expect(
      applyReadFieldWording({ steps: [{ id: "read_lead", type: "extract_text" }] }, REREAD_FIELDS)
    ).toEqual([]);
    // A field with no canonical wording to copy is left alone rather than
    // blanked: `wanted` being undefined must skip, not assign.
    const extra = cadence();
    (walkSteps(extra.steps)[0].fields as unknown[]).push({
      name: "bespoke_field",
      description: "hand-written, not ours"
    });
    expect(applyReadFieldWording(extra, ["bespoke_field"])).toEqual([]);
  });
});
