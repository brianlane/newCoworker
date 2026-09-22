import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * HQ call f76c30c0 (2026-09-22) paraphrased the end_call result
 * "ending call" into "Final check complete, hanging up now" after the
 * goodbye had already been spoken. The ack has to be a status, not a line.
 */
describe("end_call tool ack", () => {
  it("sends stay_silent instead of a speakable status", () => {
    const bridge = readFileSync(
      join(__dirname, "../vps/voice-bridge/src/gemini-telnyx-bridge.ts"),
      "utf8"
    );
    expect(bridge).toContain('detail: "stay_silent"');
    expect(bridge).not.toContain('detail: "ending call"');
  });
});
