import { describe, it, expect } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  patchDefinition,
  WAIT_STEP_ID,
  MAX_AWAIT_MINUTES
} from "../scripts/oneshot/homelight-await-call-start";

/**
 * homelight-await-call-start.ts: set awaitStartMinutes on the HomeLight flow's
 * wait_for_call step, so it waits a few minutes for the AI's call to START
 * rather than only attaching to one already in progress.
 *
 * The step was configured `withinMinutes: 30, timeoutMinutes: 45`, which reads
 * like "wait up to 45 minutes". It never did: with no live session the step
 * resolved "no_call" in zero seconds, so that config was inert.
 */

/** A trimmed stand-in for the live flow: trunk step nested nowhere special. */
function flowFixture(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      { id: "url", type: "extract_url", saveAs: "leadUrl" },
      {
        id: WAIT_STEP_ID,
        type: "wait_for_call",
        fromE164: "+14159851909",
        withinMinutes: 30,
        timeoutMinutes: 45,
        saveAs: "hl_call_outcome",
        capturePrefix: "call_",
        ...extra
      }
    ]
  };
}

describe("homelight-await-call-start: patchDefinition", () => {
  it("sets awaitStartMinutes on the wait step and reports the edit", () => {
    const def = flowFixture();
    expect(patchDefinition(def, 3)).toEqual([`${WAIT_STEP_ID}.awaitStartMinutes=3`]);
    const step = (def.steps as Array<Record<string, unknown>>)[1];
    expect(step.awaitStartMinutes).toBe(3);
    // The existing config is left alone: timeoutMinutes still governs how long
    // to wait for a call that HAS started to finish.
    expect(step.timeoutMinutes).toBe(45);
    expect(step.withinMinutes).toBe(30);
  });

  it("is idempotent: a second run reports no edits", () => {
    const def = flowFixture();
    expect(patchDefinition(def, 3)).toHaveLength(1);
    expect(patchDefinition(def, 3)).toEqual([]);
  });

  it("re-patches when the desired value changed", () => {
    const def = flowFixture({ awaitStartMinutes: 3 });
    expect(patchDefinition(def, 5)).toEqual([`${WAIT_STEP_ID}.awaitStartMinutes=5`]);
  });

  it("finds the step inside a branch arm, not just the trunk", () => {
    const def = {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        { id: "url", type: "extract_url", saveAs: "leadUrl" },
        {
          id: "b",
          type: "branch",
          question: "Still ours?",
          branches: [
            {
              id: "arm",
              label: "Yes",
              condition: { var: "leadUrl", notEquals: "none" },
              steps: [
                {
                  id: WAIT_STEP_ID,
                  type: "wait_for_call",
                  fromE164: "+14159851909",
                  saveAs: "hl_call_outcome"
                }
              ]
            }
          ],
          else: []
        }
      ]
    };
    expect(patchDefinition(def, 3)).toEqual([`${WAIT_STEP_ID}.awaitStartMinutes=3`]);
  });

  it("refuses a flow whose wait step is gone rather than silently no-opping", () => {
    const def = { version: 1, trigger: {}, steps: [{ id: "url", type: "extract_url", saveAs: "u" }] };
    expect(() => patchDefinition(def, 3)).toThrow(/no step with id/);
  });

  it("refuses when the id was reused by a different step type", () => {
    const def = {
      version: 1,
      trigger: {},
      steps: [{ id: WAIT_STEP_ID, type: "sleep", minutes: 5 }]
    };
    expect(() => patchDefinition(def, 3)).toThrow(/not a wait_for_call/);
  });

  it("produces a definition the schema still accepts", () => {
    const def = flowFixture();
    patchDefinition(def, 3);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("keeps its own ceiling under the engine's 0..60 clamp", () => {
    // A long wait here would delay every step after it, which on this flow
    // means delaying the claimer's hand-off. The script caps well below the
    // engine limit on purpose.
    expect(MAX_AWAIT_MINUTES).toBeLessThan(60);
    const def = flowFixture();
    patchDefinition(def, MAX_AWAIT_MINUTES);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });
});
