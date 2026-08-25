/**
 * Clever seller calls leave a voicemail
 * (scripts/oneshot/amy-clever-seller-voicemail.ts).
 *
 * ai_call_1/2/3 on "Clever Lead - Accept" carried no voicemailTemplate and
 * never had, across the flow's 119 runs, 116 of them sellers. So a Clever
 * seller who did not pick up heard nothing at all: three calls, three
 * silences. Every comparable call on the account already leaves one, including
 * the buyer rungs added to this same flow.
 */
import { describe, expect, it } from "vitest";
import {
  SELLER_VOICEMAILS,
  VOICEMAIL_MAX,
  patchSellerVoicemails
} from "../scripts/oneshot/amy-clever-seller-voicemail";

type Step = Record<string, unknown> & { id: string; type: string };
type Def = { steps: Step[] };

const call = (id: string, extra: Record<string, unknown> = {}): Step => ({
  id,
  type: "place_ai_call",
  toVar: "lead_phone",
  saveAs: "call_outcome",
  personaTemplate: "...selling your home...",
  ...extra
});

const fixture = (): Def => ({
  steps: [
    call("ai_call_1"),
    call("ai_call_2"),
    call("ai_call_3"),
    // The buyer rungs already have one; this script must not touch them.
    call("ai_call_buyer", { voicemailTemplate: "buyer voicemail, left alone" })
  ]
});

const vmOf = (def: Def, id: string): string | undefined =>
  def.steps.find((s) => s.id === id)?.voicemailTemplate as string | undefined;

describe("the voicemail copy", () => {
  it("covers all three seller rungs", () => {
    expect(SELLER_VOICEMAILS.map((v) => v.stepId)).toEqual([
      "ai_call_1",
      "ai_call_2",
      "ai_call_3"
    ]);
  });

  it("fits the 600-character cap", () => {
    for (const v of SELLER_VOICEMAILS) {
      expect(v.voicemail.length, `${v.stepId} is ${v.voicemail.length}`).toBeLessThanOrEqual(
        VOICEMAIL_MAX
      );
    }
  });

  it("escalates rather than repeating one message three times", () => {
    const [one, two, three] = SELLER_VOICEMAILS.map((v) => v.voicemail);
    expect(new Set([one, two, three]).size).toBe(3);
    expect(two).toContain("again");
    // Round 2 earns its place with the reason the persona leads on.
    expect(two).toContain("licensed appraiser");
    // Round 3 says out loud what the persona already tells the AI to say.
    expect(three).toMatch(/leave you be/);
    expect(three).toContain("last message");
  });

  it("names Clever and never the address var, which can be empty", () => {
    // "selling your home on ." is a worse voicemail than one that never
    // mentions the property. ReferralExchange's voicemails do the same.
    for (const v of SELLER_VOICEMAILS) {
      expect(v.voicemail).toContain("Clever");
      expect(v.voicemail).not.toContain("lead_address");
    }
  });

  it("always gives the callback number, and only the first name", () => {
    for (const v of SELLER_VOICEMAILS) {
      expect(v.voicemail).toContain("602-695-1142");
      expect(v.voicemail).toContain("{{vars.lead_name.first}}");
    }
  });

  it("carries no em dash", () => {
    for (const v of SELLER_VOICEMAILS) expect(v.voicemail).not.toContain("—");
  });
});

describe("patchSellerVoicemails", () => {
  it("installs one per seller rung and leaves the buyer rung alone", () => {
    const def = fixture();
    const { changed, problems } = patchSellerVoicemails(def, "apply");
    expect(problems).toEqual([]);
    expect(changed).toHaveLength(3);
    for (const v of SELLER_VOICEMAILS) expect(vmOf(def, v.stepId)).toBe(v.voicemail);
    expect(vmOf(def, "ai_call_buyer")).toBe("buyer voicemail, left alone");
  });

  it("pairs each voicemail with its own rung, not by position", () => {
    // Keyed by step id so a reordered ladder cannot pair round 3's
    // "we will leave you be" with the very first call.
    const def = fixture();
    def.steps = [call("ai_call_3"), call("ai_call_1"), call("ai_call_2")];
    patchSellerVoicemails(def, "apply");
    expect(vmOf(def, "ai_call_1")).toContain("We would love to help");
    expect(vmOf(def, "ai_call_3")).toContain("leave you be");
  });

  it("is idempotent and round-trips through revert", () => {
    const def = fixture();
    const before = JSON.parse(JSON.stringify(def));
    patchSellerVoicemails(def, "apply");
    expect(patchSellerVoicemails(def, "apply").changed).toEqual([]);
    expect(patchSellerVoicemails(def, "revert").changed).toHaveLength(3);
    expect(def).toEqual(before);
    expect(patchSellerVoicemails(def, "revert").changed).toEqual([]);
  });

  it("REFUSES to overwrite a voicemail somebody wrote by hand", () => {
    const edited = fixture();
    edited.steps[1].voicemailTemplate = "Amy's own wording, typed into the builder";
    const { problems } = patchSellerVoicemails(edited, "apply");
    expect(problems[0]).toContain("did not write");
    expect(vmOf(edited, "ai_call_2")).toBe("Amy's own wording, typed into the builder");

    // --force is the deliberate override.
    const forced = fixture();
    forced.steps[1].voicemailTemplate = "hand written";
    expect(patchSellerVoicemails(forced, "apply", true).problems).toEqual([]);
    expect(vmOf(forced, "ai_call_2")).toBe(SELLER_VOICEMAILS[1].voicemail);
  });

  it("leaves a hand-written voicemail alone on revert too", () => {
    // Revert removes only what this script installed.
    const def = fixture();
    def.steps[0].voicemailTemplate = "somebody else's";
    expect(patchSellerVoicemails(def, "revert").changed).toEqual([]);
    expect(vmOf(def, "ai_call_1")).toBe("somebody else's");
  });

  it("reports a missing rung rather than throwing", () => {
    const def = fixture();
    def.steps = def.steps.filter((s) => s.id !== "ai_call_3");
    expect(patchSellerVoicemails(def, "apply").problems[0]).toContain("ai_call_3");
    expect(patchSellerVoicemails({ steps: [] }, "apply").problems).toHaveLength(3);
  });
});
