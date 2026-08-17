import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  CLAIM_DETAILS_LINE,
  CLAIM_STATE_FIELD,
  CLAIM_STATUS_LINE,
  CLAIMING_LINE,
  EMAIL_LOOKBACK_MINUTES,
  EMAIL_READ_IDS,
  FIX_BRANCH_ID,
  patchDefinition,
  RETRY_STEP_ID,
  RETRY_CONTINUE_MARKER,
  STATE_UNCONFIRMED,
  VERIFY2_STEP_ID,
  VERIFY_STEP_ID
} from "../scripts/oneshot/homelight-verified-claim";

/**
 * homelight-verified-claim.ts.
 *
 * 2026-08-16: two HomeLight referrals arrived (Ana 09:09, Thomas 09:28
 * Phoenix). Both `claim_click` steps resolved HomeLight's real
 * `data-test="submit-claim-referral"` button and reported success, and Telnyx
 * carrier records show HomeLight never placed the claim callback for either.
 * Amy clicked the same button by hand at 09:40 and the callback arrived
 * within seconds. A dispatched click is not a registered claim, and the offer
 * asserted "Our AI coworker is claiming it with HomeLight now." on faith.
 *
 * The same incident exposed the reveal ladder as inert: `email_extract`
 * writes NO vars when no mailbox message matches, so every retry rung gated
 * on `<status> equals "missing"` was when_unmet-skipped, and the unclaimed
 * read's 60-minute lookback could not even reach back to the referral's
 * arrival after the ~75-minute offer ladder.
 *
 * The fixture is the live definition of 2026-08-16 (connection id and owner
 * email scrubbed), so these tests exercise the patch against the exact shape
 * it will meet in production.
 */

type Step = Record<string, any>;
type Definition = { steps: Step[] } & Record<string, any>;

function liveDefinition(): Definition {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures", "homelight-referral-live-2026-08-16.json"), "utf8")
  ) as Definition;
}

function* walk(steps: Step[] | undefined): Generator<Step> {
  for (const s of steps ?? []) {
    yield s;
    for (const arm of s.branches ?? []) yield* walk(arm.steps);
    yield* walk(s.else);
  }
}

function byId(def: Definition, id: string): Step {
  const hits = [...walk(def.steps)].filter((s) => s.id === id);
  expect(hits, `step "${id}"`).toHaveLength(1);
  return hits[0]!;
}

describe("homelight-verified-claim", () => {
  it("patches the live snapshot into a definition the platform validator accepts", () => {
    const def = liveDefinition();
    const edits = patchDefinition(def);
    expect(edits.length).toBeGreaterThan(0);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
    // Trunk cap is 30; the two inserts must leave headroom rather than land on it.
    expect(def.steps.length).toBe(29);
  });

  it("is idempotent: a second run finds nothing to do", () => {
    const def = liveDefinition();
    patchDefinition(def);
    expect(patchDefinition(def)).toEqual([]);
  });

  it("inserts verify directly after the claim steps and before the team offer", () => {
    const def = liveDefinition();
    patchDefinition(def);
    const ids = def.steps.map((s) => s.id);
    const textIdx = ids.indexOf("claim_text");
    expect(ids[textIdx + 1]).toBe(VERIFY_STEP_ID);
    expect(ids[textIdx + 2]).toBe(FIX_BRANCH_ID);
    expect(ids.indexOf("route")).toBeGreaterThan(ids.indexOf(FIX_BRANCH_ID));
  });

  it("verify steps inherit the claim click's session and never capture a screenshot", () => {
    const def = liveDefinition();
    patchDefinition(def);
    const click = byId(def, "claim_click");
    for (const id of [VERIFY_STEP_ID, VERIFY2_STEP_ID]) {
      const step = byId(def, id);
      expect(step.type).toBe("browse_extract");
      expect(step.urlVar).toBe(click.urlVar);
      expect(step.auth).toEqual(click.auth);
      expect(step.fields).toEqual([CLAIM_STATE_FIELD]);
      // The route MMS attaches the latest stored screenshot; a verify shot
      // would replace the referral card with the claim modal.
      expect(step.screenshot).toBeUndefined();
    }
  });

  it("keeps the claim_state field inside the schema's 300-char description cap", () => {
    expect(CLAIM_STATE_FIELD.description.length).toBeLessThanOrEqual(300);
    // The gate and the copy both hang off this stable marker.
    expect(STATE_UNCONFIRMED).toContain("NOT CONFIRMED");
    expect(CLAIM_STATE_FIELD.description).toContain(STATE_UNCONFIRMED);
  });

  it("retries the click only for call-mode claims, and a retry failure can never end the run", () => {
    const def = liveDefinition();
    patchDefinition(def);
    const fix = byId(def, FIX_BRANCH_ID);
    expect(fix.branches).toHaveLength(1);
    const arm = fix.branches[0];
    expect(arm.condition).toEqual({ var: "claim_state", contains: "NOT CONFIRMED" });
    expect(arm.steps.map((s: Step) => s.id)).toEqual([RETRY_STEP_ID, VERIFY2_STEP_ID]);

    const retry = byId(def, RETRY_STEP_ID);
    expect(retry.when).toEqual({ var: "claim_mode", equals: "call" });
    expect(retry.actions).toEqual([{ kind: "click_text", target: "Call me to claim referral" }]);
    // Present on any HomeLight page, so "no button anymore" (state flipped,
    // or referral gone) records skipped and verify2 reports the truth instead
    // of the run dead-lettering with the offer still unsent.
    expect(retry.continueWhenText).toBe(RETRY_CONTINUE_MARKER);
  });

  it("replaces the on-faith claim line with the verified state everywhere the team reads", () => {
    const def = liveDefinition();
    patchDefinition(def);
    const route = byId(def, "route");
    expect(route.offerTemplate).not.toContain(CLAIMING_LINE);
    expect(route.offerTemplate).toContain(CLAIM_STATUS_LINE);
    // The rescue instruction sits directly above the link that performs it.
    expect(route.ownerDirectTemplate).toContain(
      `${CLAIM_STATUS_LINE}\nTap to claim: {{vars.leadUrl}}`
    );
    expect(route.ownerFallbackTemplate).toContain(CLAIM_STATUS_LINE);
    expect(route.unclaimedReminders.detailsTemplate.endsWith(CLAIM_DETAILS_LINE)).toBe(true);
    expect(byId(def, "notify_unclaimed").message).toContain(CLAIM_STATUS_LINE);
  });

  it("new copy carries no em dash and never says receptionist", () => {
    const strings = [
      CLAIM_STATE_FIELD.description,
      CLAIM_STATUS_LINE,
      CLAIM_DETAILS_LINE,
      STATE_UNCONFIRMED
    ];
    const def = liveDefinition();
    patchDefinition(def);
    const route = byId(def, "route");
    strings.push(route.offerTemplate, route.ownerDirectTemplate, route.ownerFallbackTemplate);
    for (const s of strings) {
      expect(s).not.toMatch(/—/);
      expect(s.toLowerCase()).not.toContain("receptionist");
    }
  });

  it("revives the claimed-path late ladder: an unwritten status now means keep trying", () => {
    const def = liveDefinition();
    patchDefinition(def);
    const lateMissing = byId(def, "late_missing");
    const arm = lateMissing.branches.find((b: Step) => b.id === "late_missing_hit");
    expect(arm.condition).toEqual({ var: "contact_status", notEquals: "found" });
  });

  it("revives the unclaimed ladder's retry rungs the same way", () => {
    const def = liveDefinition();
    patchDefinition(def);
    expect(byId(def, "unclaimed_wait_2").when).toEqual({ var: "u1_status", notEquals: "found" });
    expect(byId(def, "unclaimed_email_read_2").when).toEqual({
      var: "u1_status",
      notEquals: "found"
    });
    expect(byId(def, "unclaimed_wait_3").when).toEqual({ var: "u2_status", notEquals: "found" });
    expect(byId(def, "unclaimed_email_read_3").when).toEqual({
      var: "u2_status",
      notEquals: "found"
    });
    // The alerts still fire only on an actual find.
    expect(byId(def, "late_unclaimed_alert").when).toEqual({ var: "u1_status", equals: "found" });
    expect(byId(def, "late_unclaimed_alert_2").when).toEqual({ var: "u2_status", equals: "found" });
    expect(byId(def, "late_unclaimed_alert_3").when).toEqual({ var: "u3_status", equals: "found" });
  });

  it("widens every HomeLight mailbox read to reach the referral's arrival", () => {
    const def = liveDefinition();
    patchDefinition(def);
    for (const id of EMAIL_READ_IDS) {
      const read = byId(def, id);
      expect(read.lookbackMinutes, id).toBe(EMAIL_LOOKBACK_MINUTES);
      // First-name-only matching, on purpose: the alert's price is ROUNDED
      // ($420K -> price_digits 420) while the details email carries the exact
      // figure ($419,500), so an AND-ed {{vars.price_digits}} term would
      // exclude the very email the ladder is looking for (Bugbot, PR #1400).
      expect(read.matchTemplates, id).toEqual(["{{vars.lead_first_name}}"]);
    }
  });

  it("refuses when the offer copy was edited elsewhere", () => {
    const def = liveDefinition();
    const route = byId(def, "route");
    route.offerTemplate = route.offerTemplate.replace(CLAIMING_LINE, "Something else entirely.");
    expect(() => patchDefinition(def)).toThrow(/offerTemplate/);
  });

  it("refuses when the claim steps are not where it expects them", () => {
    const def = liveDefinition();
    def.steps = def.steps.filter((s) => s.id !== "claim_text");
    expect(() => patchDefinition(def)).toThrow(/adjacent/);
  });

  it("refuses when a ladder rung gates on something it does not understand", () => {
    const def = liveDefinition();
    byId(def, "unclaimed_wait_2").when = { var: "u1_status", equals: "surprising" };
    expect(() => patchDefinition(def)).toThrow(/unclaimed_wait_2/);
  });
});
