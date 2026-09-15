/**
 * Pure half of scripts/oneshot/resume-telnyx-10015-runs.ts: resume the
 * 2026-09-15 Telnyx 10015 Idempotency-Key dead-letters at their failed
 * send_sms step, never from current_step 0.
 *
 * The IO shell is untested here. What matters is that the allowlist, the
 * 10015 matcher, and the classify/refuse rules cannot requeue HomeLight,
 * Spoke Check, or a run whose cursor moved off the failed SMS step.
 */
import { describe, expect, it } from "vitest";
import {
  EXCLUDED_RUN_IDS,
  RESUME_PATCH,
  TARGET_RUNS,
  classifyRun,
  isAllowedResumeStepType,
  isExcludedFlowName,
  looksLikeTelnyx10015,
  parseResumeArgs,
  redactPhones,
  targetRunById,
  type ClassifyInput,
  type TargetRun
} from "../scripts/oneshot/resume-telnyx-10015-runs";

const SAMPLE_10015 =
  "send_sms: the carrier rejected the text to the lead and a retry can't fix it, " +
  "usually the number isn't a real dialable line. (telnyx 400: {\"errors\":[{\"code\":\"10015\"," +
  '"title":"Bad Request","source":{"pointer":"/header/Idempotency-Key"},"detail":"invalid"}]}';

const NEW_COPY_10015 =
  "Telnyx rejected the Idempotency-Key request header and a retry of the same " +
  "header cannot fix it. This is a platform request-header problem, not an " +
  "undialable destination. the text to the lead was not rejected as a phone " +
  'number. (telnyx 400: {"errors":[{"code":"10015"}]})';

const DESTINATION_40310 =
  "send_sms: the carrier rejected the text to the lead and a retry can't fix it, " +
  "usually the number isn't a real dialable line. (telnyx 403: {\"errors\":[{\"code\":\"40310\"}]})";

const PHONE_FIXTURE = "+12223334444";

function baseInput(over: Partial<ClassifyInput> = {}): ClassifyInput {
  const target = TARGET_RUNS[0];
  return {
    id: target.id,
    status: "failed",
    currentStep: target.expectedStep,
    lastError: SAMPLE_10015,
    flowName: "Lead follow-up (white-glove build)",
    stepType: "send_sms",
    broadcastAll: null,
    ...over
  };
}

function expectTarget(): TargetRun {
  return TARGET_RUNS[0];
}

describe("allowlist", () => {
  it("is exactly the eleven Brian-approved runs, with the approved current_step", () => {
    expect(TARGET_RUNS).toHaveLength(11);
    expect(TARGET_RUNS.map((r) => r.id)).toEqual([
      "2351afb8-9ce2-40d4-8291-8b53d8be07d7",
      "c16e4acd-3e61-4a0b-ac3a-e4d247f0ef22",
      "e7dd39cb-6a98-46c7-9043-25b72c9db5bd",
      "ff8adf36-f3a7-4c21-a410-2cd277fe1741",
      "8ac9eddd-4fae-4001-8dc2-ef18423f31bf",
      "93f69577-4dc3-4ad1-a0ce-1dd12834bb8f",
      "49c5391f-dc5a-4896-b612-60f730a922d6",
      "178ea407-1568-4966-991d-9604c230340b",
      "f453b064-fb59-4c23-9f75-341dfdc8d0d0",
      "28fa9be6-b8b0-49ae-9e9a-ce4a4417cfab",
      "54c0cbc6-bbae-4fdc-bd4e-f4623aa233dd"
    ]);
    expect(TARGET_RUNS.map((r) => r.expectedStep)).toEqual([7, 7, 9, 0, 6, 12, 6, 17, 9, 6, 11]);
    expect(new Set(TARGET_RUNS.map((r) => r.id)).size).toBe(11);
  });

  it("does not include the Spoke Check run or any HomeLight-labeled target", () => {
    expect(EXCLUDED_RUN_IDS.has("6b6a0f11-6d68-43d0-afa4-2f06ffa4a1a0")).toBe(true);
    expect(TARGET_RUNS.some((r) => EXCLUDED_RUN_IDS.has(r.id))).toBe(false);
    expect(TARGET_RUNS.some((r) => /homelight/i.test(r.label))).toBe(false);
    expect(targetRunById("6b6a0f11-6d68-43d0-afa4-2f06ffa4a1a0")).toBeUndefined();
    expect(targetRunById(TARGET_RUNS[3].id)?.label).toBe("Amy Clever Homeward Offers");
  });

  it("never writes current_step, so the worker retries the failed SMS only", () => {
    expect("current_step" in RESUME_PATCH).toBe(false);
    expect(RESUME_PATCH).toEqual({
      status: "queued",
      last_error: null,
      error_retry_count: 0,
      claimed_at: null,
      earliest_claim_at: null
    });
  });
});

describe("looksLikeTelnyx10015", () => {
  it("matches the live last_error shape and the post-#1853 operator copy", () => {
    expect(looksLikeTelnyx10015(SAMPLE_10015)).toBe(true);
    expect(looksLikeTelnyx10015(NEW_COPY_10015)).toBe(true);
    expect(looksLikeTelnyx10015("/header/Idempotency-Key")).toBe(true);
  });

  it("does not treat a destination reject or empty text as 10015", () => {
    expect(looksLikeTelnyx10015(DESTINATION_40310)).toBe(false);
    expect(looksLikeTelnyx10015("")).toBe(false);
    expect(looksLikeTelnyx10015(null)).toBe(false);
    expect(looksLikeTelnyx10015("telnyx 400 something else")).toBe(false);
    expect(looksLikeTelnyx10015("idempotency-key without telnyx")).toBe(false);
  });
});

describe("flow and step guards", () => {
  it("excludes HomeLight and Spoke Check by name", () => {
    expect(isExcludedFlowName("HomeLight Referral")).toBe(true);
    expect(isExcludedFlowName("Clever - Spoke Check & Weekly Call Follow-Up")).toBe(true);
    expect(isExcludedFlowName("Lead follow-up (white-glove build)")).toBe(false);
    expect(isExcludedFlowName("Clever Homeward Offers")).toBe(false);
  });

  it("only resumes send_sms, never a route_to_team offer/broadcast", () => {
    expect(isAllowedResumeStepType("send_sms", null)).toBe(true);
    expect(isAllowedResumeStepType("route_to_team", null)).toBe(false);
    expect(isAllowedResumeStepType("route_to_team", true)).toBe(false);
    expect(isAllowedResumeStepType("send_sms", true)).toBe(false);
    expect(isAllowedResumeStepType(null)).toBe(false);
  });
});

describe("classifyRun", () => {
  it("resumes a failed send_sms still parked on the approved step with 10015 evidence", () => {
    const result = classifyRun(baseInput(), expectTarget());
    expect(result.action).toBe("resume");
    expect(result.reason).toContain("current_step 7");
  });

  it("resumes when last_error is empty but system logs carry the header failure", () => {
    const result = classifyRun(
      baseInput({ lastError: null, logEvidence: SAMPLE_10015 }),
      expectTarget()
    );
    expect(result.action).toBe("resume");
  });

  it("no-ops a run the worker already claimed or finished", () => {
    expect(classifyRun(baseInput({ status: "queued" }), expectTarget()).action).toBe("skip");
    expect(classifyRun(baseInput({ status: "running" }), expectTarget()).action).toBe("skip");
    expect(classifyRun(baseInput({ status: "done" }), expectTarget()).action).toBe("skip");
    expect(classifyRun(baseInput({ status: "canceled" }), expectTarget()).action).toBe("skip");
  });

  it("refuses a cursor that moved, a non-SMS step, missing evidence, and excluded flows", () => {
    expect(classifyRun(baseInput({ currentStep: 0 }), expectTarget()).action).toBe("refuse");
    expect(classifyRun(baseInput({ stepType: "route_to_team" }), expectTarget()).action).toBe(
      "refuse"
    );
    expect(classifyRun(baseInput({ lastError: DESTINATION_40310 }), expectTarget()).action).toBe(
      "refuse"
    );
    expect(classifyRun(baseInput({ lastError: null }), expectTarget()).action).toBe("refuse");
    expect(
      classifyRun(baseInput({ flowName: "HomeLight Referral" }), expectTarget()).action
    ).toBe("refuse");
    expect(
      classifyRun(
        baseInput({ flowName: "Clever - Spoke Check & Weekly Call Follow-Up" }),
        expectTarget()
      ).action
    ).toBe("refuse");
    expect(classifyRun(baseInput({ status: "awaiting_reply" }), expectTarget()).action).toBe(
      "refuse"
    );
  });

  it("refuses the Spoke Check id even if the rest of the row looks like a 10015 SMS", () => {
    const spoke = "6b6a0f11-6d68-43d0-afa4-2f06ffa4a1a0";
    const fakeExpected: TargetRun = { id: spoke, expectedStep: 4, label: "should never resume" };
    expect(
      classifyRun(baseInput({ id: spoke, currentStep: 4 }), fakeExpected).reason
    ).toMatch(/excluded/i);
  });

  it("refuses when the input id does not match the expected allowlist row", () => {
    expect(classifyRun(baseInput({ id: TARGET_RUNS[1].id }), expectTarget()).action).toBe("refuse");
  });
});

describe("parseResumeArgs", () => {
  it("defaults to the full allowlist and dry-run", () => {
    expect(parseResumeArgs([])).toEqual({
      ok: true,
      apply: false,
      runIds: TARGET_RUNS.map((r) => r.id)
    });
    expect(parseResumeArgs(["--apply"])).toMatchObject({ ok: true, apply: true });
  });

  it("subsets with --run-id and refuses ids outside the allowlist", () => {
    const id = TARGET_RUNS[4].id;
    expect(parseResumeArgs(["--run-id", id, "--apply"])).toEqual({
      ok: true,
      apply: true,
      runIds: [id]
    });
    const bad = parseResumeArgs(["--run-id", "6b6a0f11-6d68-43d0-afa4-2f06ffa4a1a0"]);
    expect(bad.ok).toBe(false);
    const unknown = parseResumeArgs(["--run-id", "00000000-0000-0000-0000-000000000000"]);
    expect(unknown.ok).toBe(false);
    expect(parseResumeArgs(["--nope"]).ok).toBe(false);
    expect(parseResumeArgs(["--run-id"]).ok).toBe(false);
  });
});

describe("redactPhones", () => {
  it("strips E.164 from operator copy so apply logs stay PII-free", () => {
    const withPhone = `send_sms failed for ${PHONE_FIXTURE} (telnyx 400)`;
    expect(redactPhones(withPhone)).not.toContain(PHONE_FIXTURE);
    expect(redactPhones(withPhone)).toContain("+[redacted]");
    expect(redactPhones("no number")).toBe("no number");
  });
});
