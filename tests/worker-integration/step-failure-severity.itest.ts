import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFlow, enqueueRun, getRun, seedBusiness, serviceDb, tickWorker } from "./harness";

/**
 * Step-failure log severity (Amy Laidlaw, 2026-07-31): the fleet-wide admin
 * "System Errors" panel selects `system_logs.level = 'error'` with no dedupe,
 * so it filled with `ai_flow_step_failed` rows from a HomeLight browse step
 * that hit a 30s render navigation timeout, got retried, and whose run then
 * finished `done`. Runs that ended fine were crowding out the ones that did
 * not.
 *
 * A step failure is now `error` only when it actually ends the run, and `warn`
 * while the worker still intends to retry. The level ladder itself is unit
 * tested (`stepLogLevel` in tests/system-log-shared.test.ts); what needs a
 * REAL worker and a REAL Postgres is the wiring: that the retryable call site
 * passes the live `error_retry_count`, that it agrees with `handleRunThrow`'s
 * own re-queue predicate, and that the flip to `error` lands on exactly the
 * attempt that dead-letters.
 */

/**
 * A page read that always throws. `.invalid` is reserved by RFC 2606 and never
 * resolves, so `fetchStatic` raises a DNS error, which the worker treats as a
 * TRANSIENT step failure and re-queues. No render sidecar or network egress
 * needed, and the guard in `isUnsafeBrowseHost` lets it through (it is not
 * localhost, not `.internal`, not a private IP literal).
 */
const UNREACHABLE = "https://itest-step-severity.invalid/lead";

/**
 * `extract_url` first, not a seeded run var: the schema enforces var
 * provenance (`urlVar "x" which no earlier step produces`), and pulling the
 * URL off the trigger is both deterministic and how the real HomeLight flow
 * starts.
 */
function browseFlow(): Record<string, unknown> {
  const def = {
    version: 1,
    trigger: { channel: "tenant_email", conditions: [] },
    steps: [
      { id: "url", type: "extract_url", saveAs: "page_url" },
      {
        id: "read",
        type: "browse_extract",
        urlVar: "page_url",
        fields: [{ name: "lead_name", description: "The lead's name on the page" }]
      }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

const TRIGGER = {
  channel: "tenant_email",
  from: "alerts@example.com",
  subject: "New lead",
  windowText: `A lead arrived. Portal: ${UNREACHABLE}`
};

type LogRow = { level: string; event: string; payload: Record<string, unknown> };

async function stepFailedLogs(
  db: SupabaseClient,
  businessId: string,
  runId: string
): Promise<LogRow[]> {
  const { data } = await db
    .from("system_logs")
    .select("level,event,payload")
    .eq("business_id", businessId)
    .eq("event", "ai_flow_step_failed")
    .contains("payload", { run_id: runId })
    .order("created_at");
  return (data ?? []) as LogRow[];
}

let db: SupabaseClient;

beforeAll(() => {
  db = serviceDb();
});

describe("ai_flow_step_failed severity (real worker)", () => {
  it("logs retryable step failures at warn and only the dead-lettering attempt at error", async () => {
    const biz = await seedBusiness(db, "IT step failure severity");
    const flowId = await createFlow(db, biz, browseFlow());
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    // MAX_ATTEMPTS is 4, counted on error_retry_count: four re-queues, then the
    // fifth pass dead-letters. Tick past the budget so both sides of the flip
    // are exercised in one run.
    for (let i = 0; i < 6; i++) {
      await tickWorker();
      const run = await getRun(db, runId);
      if (run.status === "failed") break;
    }

    const run = await getRun(db, runId);
    expect(run.status).toBe("failed");
    expect(run.last_error).toMatch(/^max retries:/);

    const logs = await stepFailedLogs(db, biz, runId);
    expect(logs.length).toBeGreaterThan(1);

    // Every attempt before the last one was retryable: warn, and explicitly
    // marked non-terminal so the payload explains the absence from the panel.
    for (const row of logs.slice(0, -1)) {
      expect(row.level).toBe("warn");
      expect(row.payload.terminal).toBe(false);
    }

    // The attempt that ended the run is the one that earns an error.
    const last = logs[logs.length - 1];
    expect(last.level).toBe("error");
    expect(last.payload.terminal).toBe(true);

    // Exactly one error row for the whole dead-lettered run, which is the
    // property the fleet panel depends on.
    expect(logs.filter((l) => l.level === "error")).toHaveLength(1);
  });

  it("logs a run-ending PLAN failure at error on the first attempt, with no retries", async () => {
    const biz = await seedBusiness(db, "IT step failure terminal");
    // A LITERAL "none"-class recipient is a hard plan failure: it is a
    // flow-config bug rather than a lead-data gap, so unlike a templated one
    // it does not skip. The planner returns ok:false, the worker fails the run
    // immediately, and there is no retry to wait for. (A templated empty
    // recipient cannot be used here: the schema rejects a var no earlier step
    // produces, and the whole point of this PR is that it now skips anyway.)
    const def = {
      version: 1,
      trigger: { channel: "tenant_email", conditions: [] },
      steps: [
        {
          id: "mail",
          type: "send_email",
          to: "none",
          subject: "A lead arrived",
          body: "hello"
        }
      ]
    };
    parseAiFlowDefinition(def);
    const flowId = await createFlow(db, biz, def);
    const runId = await enqueueRun(db, flowId, biz, TRIGGER);

    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("failed");

    const logs = await stepFailedLogs(db, biz, runId);
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("error");
    expect(logs[0].payload.terminal).toBe(true);
  });
});
