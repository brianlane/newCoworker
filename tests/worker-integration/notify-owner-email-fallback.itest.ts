import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createFlow,
  enqueueRun,
  getRun,
  getSteps,
  seedBusiness,
  serviceDb,
  tickWorker
} from "./harness";
import { startFakeApp, type FakeApp } from "./fake-app";

/**
 * notify_owner email fallback (real worker + real notifications function):
 * when the owner's forwarding number cannot receive our SMS (non-NANP; the
 * platform's long codes are domestic-only, Telnyx ticket #557577) or no
 * number is set at all, the notify CONTENT still reaches the owner through
 * the notifications function's email + dashboard legs, and the SMS leg is
 * recorded as skipped (`sms_fallback_source`) rather than re-attempted.
 *
 * Born from the Aug 6 2026 Canada-whitelist outage: James's notify_owner
 * texts burned four retries each and he never learned a new customer had
 * arrived. The rejected-at-carrier arm of the fallback shares this plumbing
 * and is pinned by unit tests (tests/owner-notify-fallback.test.ts).
 */

const TRIGGER = {
  channel: "webhook",
  from: "",
  windowText: "lead webhook"
};

function notifyFlow(): Record<string, unknown> {
  const def = {
    version: 1,
    trigger: { channel: "webhook", conditions: [] },
    steps: [{ id: "notify", type: "notify_owner", message: "A new lead arrived" }]
  };
  parseAiFlowDefinition(def);
  return def;
}

let db: SupabaseClient;
// The NANP control case sends a real (faked) Telnyx text; the fallback
// cases must complete with no Telnyx call at all.
let app: FakeApp;

beforeAll(async () => {
  db = serviceDb();
  app = await startFakeApp();
});

afterAll(async () => {
  await app.close();
});

async function fallbackRows(biz: string, runId: string) {
  const { data } = await db
    .from("notifications")
    .select("delivery_channel, status, payload")
    .eq("business_id", biz)
    .eq("payload->>taskType", "owner_notify_fallback")
    .eq("payload->>runId", runId);
  return (data ?? []) as Array<{
    delivery_channel: string;
    status: string;
    payload: Record<string, unknown>;
  }>;
}

/**
 * Seed the SMS config the same way the other worker itests do
 * (bad-phone-backstop.itest.ts). Without a messaging profile,
 * `messagingConfig` returns null and notify_owner returns early at its
 * `if (!cfg)` guard, so every assertion below would read a null `notified`
 * and the fallback logic under test would never be reached. The insert
 * error is checked rather than discarded, because a silently rejected seed
 * looks exactly like that same early return.
 */
async function seedSmsConfig(biz: string, forward?: string) {
  const row: Record<string, unknown> = {
    business_id: biz,
    telnyx_messaging_profile_id: "itest-profile",
    telnyx_sms_from_e164: "+16025550100"
  };
  if (forward) row.forward_to_e164 = forward;
  const { error } = await db.from("business_telnyx_settings").upsert(row);
  if (error) throw new Error(`telnyx settings: ${error.message}`);
}

/** A forwarding number and deliberately NO messaging profile. */
async function seedForwardOnly(biz: string, forward: string) {
  const { error } = await db
    .from("business_telnyx_settings")
    .upsert({ business_id: biz, forward_to_e164: forward });
  if (error) throw new Error(`telnyx settings: ${error.message}`);
}

describe("notify_owner email fallback (real worker)", () => {
  it("routes an unreachable (non-NANP) forwarding number to email, never attempting SMS", async () => {
    const biz = await seedBusiness(db, "IT notify fallback HK");
    await seedSmsConfig(biz, "+85261234567");
    const flowId = await createFlow(db, biz, notifyFlow());

    const runId = await enqueueRun(db, flowId, biz, TRIGGER, {});
    await tickWorker();

    const run = await getRun(db, runId);
    expect(run.status).toBe("done");
    const notify = (await getSteps(db, runId)).find((s) => s.step_type === "notify_owner");
    expect(notify?.status).toBe("done");
    expect((notify?.result as { notified?: string }).notified).toBe("email");
    expect((notify?.result as { fallback?: string }).fallback).toBe("sms_unreachable");

    // The notifications function delivered the CONTENT (message, not a
    // generic failure line) and recorded the SMS leg as fallback-suppressed.
    const rows = await fallbackRows(biz, runId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => String(r.payload.summary).includes("A new lead arrived"))).toBe(true);
    expect(rows.every((r) => r.payload.fallbackReason === "sms_unreachable")).toBe(true);
    const sms = rows.find((r) => r.delivery_channel === "sms");
    expect(sms?.status).toBe("skipped");
    const dashboard = rows.find((r) => r.delivery_channel === "dashboard");
    expect(dashboard?.status).toBe("sent");

    // No owner_notify text was attempted for this run.
    const { data: sends } = await db
      .from("sms_outbound_log")
      .select("id")
      .eq("business_id", biz)
      .eq("source", "owner_notify");
    expect((sends ?? []).length).toBe(0);
  });

  it("a business with NO forwarding number gets the content by email instead of silence", async () => {
    const biz = await seedBusiness(db, "IT notify fallback no phone");
    // SMS is fully configured here and only the forwarding number is
    // missing, so this exercises the no_phone branch on its own merit. With
    // no settings row at all it would pass for the wrong reason: the
    // `if (!cfg)` early return sits just below the no_phone branch.
    await seedSmsConfig(biz);
    const flowId = await createFlow(db, biz, notifyFlow());

    const runId = await enqueueRun(db, flowId, biz, TRIGGER, {});
    await tickWorker();

    expect((await getRun(db, runId)).status).toBe("done");
    const notify = (await getSteps(db, runId)).find((s) => s.step_type === "notify_owner");
    expect(notify?.status).toBe("done");
    expect((notify?.result as { notified?: string }).notified).toBe("email");
    expect((notify?.result as { fallback?: string }).fallback).toBe("no_phone");

    const rows = await fallbackRows(biz, runId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.payload.fallbackReason === "no_phone")).toBe(true);
  });

  // Pins the CHECK ORDER, not just the outcome. An unreachable number cannot
  // receive our SMS whether or not we hold a messaging profile, so the email
  // has to win over the `if (!cfg)` guard. With the two the other way round
  // this exact tenant went silent, and no other case in this file catches it:
  // every other one seeds a profile.
  it("emails an unreachable number even with NO messaging profile configured", async () => {
    const biz = await seedBusiness(db, "IT notify fallback HK no profile");
    await seedForwardOnly(biz, "+85261234567");
    const flowId = await createFlow(db, biz, notifyFlow());

    const runId = await enqueueRun(db, flowId, biz, TRIGGER, {});
    await tickWorker();

    expect((await getRun(db, runId)).status).toBe("done");
    const notify = (await getSteps(db, runId)).find((s) => s.step_type === "notify_owner");
    expect(notify?.status).toBe("done");
    expect((notify?.result as { notified?: string }).notified).toBe("email");
    expect((notify?.result as { fallback?: string }).fallback).toBe("sms_unreachable");

    const rows = await fallbackRows(biz, runId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.payload.fallbackReason === "sms_unreachable")).toBe(true);
  });

  it("a reachable NANP forwarding number still goes by SMS, no fallback rows", async () => {
    const biz = await seedBusiness(db, "IT notify fallback nanp");
    await seedSmsConfig(biz, "+16025550188");
    const flowId = await createFlow(db, biz, notifyFlow());

    const runId = await enqueueRun(db, flowId, biz, TRIGGER, {});
    await tickWorker();

    expect((await getRun(db, runId)).status).toBe("done");
    const notify = (await getSteps(db, runId)).find((s) => s.step_type === "notify_owner");
    expect(notify?.status).toBe("done");
    expect((notify?.result as { notified?: string }).notified).toBe("+16025550188");
    expect(await fallbackRows(biz, runId)).toHaveLength(0);
  });
});
