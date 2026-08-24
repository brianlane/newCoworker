/**
 * Clever's price gates read a buyer's budget RANGE
 * (scripts/oneshot/amy-clever-buyer-price-range.ts).
 *
 * `price_gate` ($500K+ to the team) and `price_under_1m` (from `price_digits`,
 * $1M+ kept for Amy) between them gate five steps. Both are worded for a
 * seller's single figure, and a buyer referral shows a range instead. With no
 * rule for two numbers, `price_gate` falls to its own default of "ai", so a
 * buyer is AI-owned whatever their budget.
 *
 * The rule added in three places: judge a range by its TOP. That is the
 * buyer's ceiling, and it is the human-first direction, so a wide-ranged
 * high-dollar buyer is not quietly handed to the AI.
 */
import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_MAX,
  FIELD_EDITS,
  READ_STEP_ID,
  patchPriceFields,
  readFields
} from "../scripts/oneshot/amy-clever-buyer-price-range";

type Field = { name: string; description: string };
type Def = { steps: Array<Record<string, unknown>> };

/** `read_details` carrying the live pre-patch wording. */
function fixture(): Def {
  return {
    steps: [
      {
        id: READ_STEP_ID,
        type: "browse_extract",
        urlVar: "lead_url",
        fields: [
          { name: "lead_name", description: "The seller's full name" },
          ...FIELD_EDITS.map((e) => ({ name: e.name, description: e.previous })),
          {
            name: "price_band",
            description: "Answer exactly one lowercase token: over_1m or under_1m."
          }
        ]
      }
    ]
  };
}

const descOf = (def: Def, name: string) =>
  ((readFields(def) ?? []) as Field[]).find((f) => f.name === name)?.description ?? "";

describe("the range rule", () => {
  it("fits the schema's 300-character cap on a field description", () => {
    // The first draft of this patch read well and was rejected outright:
    // extractFieldSchema caps description at 300, and the failure surfaces
    // only as "Invalid AiFlow definition" with no field named. Pinning the
    // length here fails on the exact constant instead.
    for (const e of FIELD_EDITS) {
      expect(e.wanted.length, `${e.name} wanted is ${e.wanted.length} chars`).toBeLessThanOrEqual(
        DESCRIPTION_MAX
      );
      expect(e.previous.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    }
  });

  it("tells both GATES to collapse a range to its TOP", () => {
    // price_gate decides team vs AI; price_digits feeds the math behind
    // price_under_1m, which decides whether Amy keeps the lead. Fixing one
    // and not the other leaves half the sorting broken.
    const names = FIELD_EDITS.map((e) => e.name);
    expect(names).toContain("price_gate");
    expect(names).toContain("price_digits");
    for (const e of FIELD_EDITS.filter((x) => x.name !== "price")) {
      expect(e.wanted).toContain("TOP");
      expect(e.wanted).toMatch(/RANGE/);
    }
  });

  it("leaves price_band alone, because nothing reads it", () => {
    // Every gate goes through price_gate or price_under_1m. Rewording a
    // field with no consumers is churn that reads like a fix.
    expect(FIELD_EDITS.map((e) => e.name)).not.toContain("price_band");
  });

  it("keeps a single figure working, which is all 116 seller runs", () => {
    // The seller path must not move. Each new description still leads with
    // the single-figure instruction and its example.
    for (const e of FIELD_EDITS) {
      expect(e.wanted).toMatch(/\$425,000|613000|\$500,000/);
    }
    expect(descOf(fixtureApplied(), "price_gate")).toContain("$500,000 or more");
  });

  it("still answers 'none' / '0' when the page shows no price at all", () => {
    expect(descOf(fixtureApplied(), "price")).toContain("answer exactly: none");
    expect(descOf(fixtureApplied(), "price_digits")).toContain("answer exactly: 0");
  });

  it("asks price for the range VERBATIM, since it only ever prints", () => {
    // `price` has no gate reading it, only team-facing notices. "300000 to
    // 450000" is honest there; collapsing it to one end would state a
    // number the referral never gave.
    expect(descOf(fixtureApplied(), "price")).toContain("exactly as written");
    expect(descOf(fixtureApplied(), "price")).not.toContain("TOP");
  });

  it("carries no em dash", () => {
    for (const e of FIELD_EDITS) expect(e.wanted).not.toContain("—");
  });
});

function fixtureApplied(): Def {
  const def = fixture();
  patchPriceFields(def, "apply");
  return def;
}

describe("patchPriceFields", () => {
  it("rewrites exactly the three fields and nothing else", () => {
    const def = fixture();
    const { changed, problems } = patchPriceFields(def, "apply");
    expect(problems).toEqual([]);
    expect(changed).toHaveLength(3);
    expect(descOf(def, "lead_name")).toBe("The seller's full name");
    expect(descOf(def, "price_band")).toContain("over_1m or under_1m");
  });

  it("is idempotent and round-trips through revert", () => {
    const def = fixture();
    const before = JSON.parse(JSON.stringify(def));
    patchPriceFields(def, "apply");
    expect(patchPriceFields(def, "apply").changed).toEqual([]);
    expect(patchPriceFields(def, "revert").changed).toHaveLength(3);
    expect(def).toEqual(before);
    expect(patchPriceFields(def, "revert").changed).toEqual([]);
  });

  it("REFUSES to overwrite a description somebody edited by hand", () => {
    // This flow is edited in the builder. Clobbering an edit would destroy
    // work with no trace, so an unrecognised description stops the write.
    const edited = fixture();
    ((readFields(edited) ?? []) as Field[]).find((f) => f.name === "price_gate")!.description =
      "Amy's own wording, typed into the builder";
    const { changed, problems } = patchPriceFields(edited, "apply");
    expect(problems[0]).toContain("does not recognise");
    expect(descOf(edited, "price_gate")).toBe("Amy's own wording, typed into the builder");
    // The other two are still reported as changed; the caller refuses to
    // write anything at all while problems is non-empty.
    expect(changed).toHaveLength(2);

    // --force is the deliberate override.
    const forced = fixture();
    ((readFields(forced) ?? []) as Field[]).find((f) => f.name === "price_gate")!.description =
      "hand edited";
    expect(patchPriceFields(forced, "apply", true).problems).toEqual([]);
    expect(descOf(forced, "price_gate")).toContain("its TOP");
  });

  it("reports a missing step or field rather than throwing", () => {
    expect(patchPriceFields({ steps: [] }, "apply").problems[0]).toContain("is missing");
    expect(readFields({ steps: [] })).toBeNull();
    expect(readFields({ steps: [{ id: READ_STEP_ID }] })).toBeNull();

    const short = fixture();
    short.steps[0].fields = [{ name: "price", description: FIELD_EDITS[0].previous }];
    const { problems } = patchPriceFields(short, "apply");
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toContain("price_gate");
    expect(problems.join(" ")).toContain("price_digits");
  });
});
