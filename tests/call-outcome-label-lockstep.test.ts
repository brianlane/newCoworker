import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callOutcomeLabel } from "../supabase/functions/_shared/ai_flows/call_outcome_meta";

/**
 * The VPS voice bridge is a separate Node runtime and cannot import the Deno
 * `_shared` module, so it carries its own copy of the outcome phrasing
 * (`callOutcomeLabelMirror`). That copy is written into `ai_flow_runs` the
 * moment a live transfer connects, so a drifted phrase would reach a
 * teammate's phone reading differently depending on WHICH writer resolved the
 * call, which is exactly the sort of split-brain the lockstep note in
 * call_outcome.ts exists to prevent.
 *
 * Same shape as tests/voice-name-lockstep.test.ts: scan the real source.
 */

const ROOT = join(__dirname, "..");
const BRIDGE_SRC = readFileSync(join(ROOT, "vps/voice-bridge/src/index.ts"), "utf8");

describe("bridge outcome-label mirror stays in lockstep", () => {
  // Only the outcomes the bridge itself can deliver. It never has a reason to
  // report (a machine verdict comes from the call-end webhook), so the
  // reason-specific phrases deliberately live only in the shared module.
  it.each(["transferred", "answered", "no_answer"] as const)(
    "quotes the shared phrase for %s verbatim",
    (outcome) => {
      const shared = callOutcomeLabel(outcome);
      expect(shared).not.toBe("call outcome unknown");
      expect(
        BRIDGE_SRC,
        `bridge mirror must contain the shared phrase "${shared}" for ${outcome}`
      ).toContain(`"${shared}"`);
    }
  );

  it("writes both companion vars alongside the outcome", () => {
    // A resume that sets only the coarse outcome leaves a template reading
    // {{vars.call_outcome_label}} empty after a call that ended NORMALLY,
    // while the same template after a refusal reads fine.
    expect(BRIDGE_SRC).toContain("`${saveAs}_reason`");
    expect(BRIDGE_SRC).toContain("`${saveAs}_label`");
    expect(BRIDGE_SRC).toContain("callOutcomeLabelMirror(outcome)");
  });
});
