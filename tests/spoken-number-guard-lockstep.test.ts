import { describe, expect, it } from "vitest";
import {
  extractSpokenNumbers as bridgeExtract,
  spokenNumberForm as bridgeForm
} from "../vps/voice-bridge/src/spoken-number-guard";
import {
  extractSpokenNumbers as sweepExtract,
  spokenNumberForm as sweepForm
} from "../supabase/functions/_shared/call_integrity.ts";

/**
 * The bridge's call-time firewall and the daily sweep's detector MUST agree
 * on what counts as a spoken phone number: a number the guard allows but the
 * sweep flags would page a human about legitimately played audio, and the
 * reverse would let a fabrication through unreported. The bridge is its own
 * npm package and cannot import the Deno module, so the extraction is a
 * lockstep copy pinned here (the same pattern as tests/star-block.test.ts
 * and tests/voice-voicemail-timing.test.ts).
 *
 * The corpus mixes every shape either side has seen on real calls: the
 * fabrications, the authored script number, E.164s, parenthesized and dotted
 * forms, bare digit runs, and the near-misses (zips, street numbers, years,
 * prices) that must NOT match.
 */
const CORPUS = [
  "please call us back at 480-400-0588. Thanks!",
  "Give us a call back at 602-695-1142.",
  "+16026951142",
  "reach me at 4804000588 anytime",
  "that's +1 (602) 695 1142, got it",
  "(480) 400-0588 or 480.256.2580",
  "the home at 859 W Desert Seasons Dr, San Tan Valley, AZ 85143 listed at $385,000",
  "press one to be connected",
  "my number is 480 577 0534 and my zip is 85213",
  "1-800-555-0199 ext 12345",
  "no digits at all",
  "",
  "the year 2026 and 7264 apart"
];

const FORM_INPUTS: unknown[] = [
  "+16026951142",
  "16026951142",
  "6026951142",
  "(480) 400-0588",
  "480.577.0534",
  "12345",
  "not a number",
  "",
  null,
  undefined,
  4804000588
];

describe("spoken-number extraction lockstep (bridge vs sweep)", () => {
  it("extractSpokenNumbers agrees on every corpus line", () => {
    for (const line of CORPUS) {
      expect(bridgeExtract(line), `extract mismatch on: ${line}`).toEqual(sweepExtract(line));
    }
  });

  it("spokenNumberForm agrees on every input shape", () => {
    for (const input of FORM_INPUTS) {
      expect(bridgeForm(input), `form mismatch on: ${String(input)}`).toEqual(sweepForm(input));
    }
  });
});
