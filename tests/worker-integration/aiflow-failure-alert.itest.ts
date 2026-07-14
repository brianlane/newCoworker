import { beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFlow, enqueueRun, getRun, seedBusiness, serviceDb, tickWorker } from "./harness";

/**
 * Opt-in AiFlow failure alerts, end to end against the REAL worker + REAL
 * notifications function: a lead-intake run that dead-letters must page the
 * owner ONLY when `notification_preferences.aiflow_failure_alerts` is true —
 * the default (false / no prefs row) stays exactly as silent as before.
 *
 * The failure is the real Truly shape (2026-07-10): a Privyr-style
 * tenant_email trigger whose window text carries NO usable phone, so the
 * extract fallback yields nothing and `upsert_customer` fails the run with
 * the PR #480 readable error.
 */

let db: SupabaseClient;

beforeAll(() => {
  db = serviceDb();
});

/** Lead-intake fixture that ALWAYS dead-letters: no phone to extract. */
function failingLeadIntakeFlow(): Record<string, unknown> {
  const def = {
    version: 1,
    trigger: {
      channel: "tenant_email",
      conditions: [{ type: "from_matches", value: "lead-forwarding@privyr.com" }]
    },
    options: { suppressDefaultReply: false },
    steps: [
      {
        id: "extract",
        type: "extract_text",
        fields: [
          { name: "lead_name", description: "The lead's full name" },
          { name: "lead_phone", description: "The lead's phone number" }
        ]
      },
      {
        id: "file_lead",
        type: "upsert_customer",
        phoneVar: "lead_phone",
        nameVar: "lead_name"
      }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

const PHONELESS_TRIGGER = {
  channel: "tenant_email",
  from: "lead-forwarding@privyr.com",
  to: "leads@example.com",
  subject: "New Lead: Fah",
  windowText:
    "New Lead: Fah\nCongrats! You've received a new lead from Muhammad Fahad " +
    "Lead via Privyr Lead Forms - Auto Lead Name: Fah Phone: Email: Comments:"
};

async function failRunForBusiness(biz: string): Promise<string> {
  const flowId = await createFlow(db, biz, failingLeadIntakeFlow());
  const runId = await enqueueRun(db, flowId, biz, PHONELESS_TRIGGER);
  await tickWorker();
  const run = await getRun(db, runId);
  expect(run.status).toBe("failed");
  // The PR #480 readable message, not the old cryptic one.
  expect(run.last_error).toContain("missing or unusable");
  return runId;
}

async function alertRows(biz: string, runId: string) {
  const { data, error } = await db
    .from("notifications")
    .select("delivery_channel, status, summary, payload")
    .eq("business_id", biz)
    .eq("payload->>taskType", "aiflow_run_failed")
    .eq("payload->>runId", runId);
  if (error) throw new Error(error.message);
  return data as Array<{
    delivery_channel: string;
    status: string;
    summary: string;
    payload: Record<string, unknown>;
  }>;
}

describe("aiflow failure alerts (opt-in, real notifications function)", () => {
  it("default (no prefs row): a dead-lettered lead-intake run pages NOBODY", async () => {
    const biz = await seedBusiness(db, "IT failure-alert default");
    const runId = await failRunForBusiness(biz);
    expect(await alertRows(biz, runId)).toHaveLength(0);
  });

  it("toggle explicitly false: still silent", async () => {
    const biz = await seedBusiness(db, "IT failure-alert off");
    const { error } = await db
      .from("notification_preferences")
      .insert({ business_id: biz, aiflow_failure_alerts: false });
    if (error) throw new Error(error.message);
    const runId = await failRunForBusiness(biz);
    expect(await alertRows(biz, runId)).toHaveLength(0);
  });

  it("opted in: the failed run pages the owner through the REAL notifications function", async () => {
    const biz = await seedBusiness(db, "IT failure-alert on");
    const { error } = await db
      .from("notification_preferences")
      .insert({ business_id: biz, aiflow_failure_alerts: true });
    if (error) throw new Error(error.message);
    const runId = await failRunForBusiness(biz);

    const rows = await alertRows(biz, runId);
    expect(rows.length).toBeGreaterThan(0);
    // Dashboard channel delivers even with Telnyx/Resend unconfigured in the
    // itest stack (those channels record skipped rows instead).
    const dashboard = rows.find((r) => r.delivery_channel === "dashboard");
    expect(dashboard?.status).toBe("sent");
    // Owner-readable copy: which lead, and that an automation stopped.
    expect(dashboard?.summary).toContain("An AiFlow stopped");
    expect(dashboard?.summary).toContain("missing or unusable");
  });
});
