import { describe, expect, it } from "vitest";
import { tenantScreenshotPath } from "../supabase/functions/_shared/ai_flows/screenshot_guard";

/**
 * screenshot_path tenant guard: the var is worker-written in the normal
 * case, but it shares scope.vars with extraction outputs (whose VALUES
 * inbound text controls), so the consuming sinks accept only paths under
 * the run's own business prefix — a crafted value naming another tenant's
 * `businessId/runId/step-N.jpg` reads as "no screenshot".
 */

const BIZ = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("tenantScreenshotPath", () => {
  it("passes the worker-written shape for this business", () => {
    expect(tenantScreenshotPath(BIZ, `${BIZ}/run-1/step-3.jpg`)).toBe(
      `${BIZ}/run-1/step-3.jpg`
    );
    expect(tenantScreenshotPath(BIZ, `  ${BIZ}/run-1/step-3-before.jpg  `)).toBe(
      `${BIZ}/run-1/step-3-before.jpg`
    );
  });

  it("rejects another tenant's path, prefix tricks, and traversal shapes", () => {
    expect(tenantScreenshotPath(BIZ, `${OTHER}/run-9/step-1.jpg`)).toBe("");
    // A path merely STARTING with the business id string but under a longer
    // segment must not pass ("<biz>x/..." is not "<biz>/...").
    expect(tenantScreenshotPath(BIZ, `${BIZ}x/run-1/step-1.jpg`)).toBe("");
    expect(tenantScreenshotPath(BIZ, `${BIZ}/../${OTHER}/run-9/step-1.jpg`)).toBe("");
    expect(tenantScreenshotPath(BIZ, `${BIZ}\\run-1\\step-1.jpg`)).toBe("");
  });

  it("treats non-strings and empties as no screenshot", () => {
    expect(tenantScreenshotPath(BIZ, undefined)).toBe("");
    expect(tenantScreenshotPath(BIZ, null)).toBe("");
    expect(tenantScreenshotPath(BIZ, 42)).toBe("");
    expect(tenantScreenshotPath(BIZ, "")).toBe("");
    expect(tenantScreenshotPath(BIZ, "   ")).toBe("");
  });
});
