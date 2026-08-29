/**
 * Fire ONE real owner alert through the DEPLOYED Supabase edge function, to
 * prove the push leg of the Deno dispatcher end to end.
 *
 * This is the sibling of debug/push-live-alert.ts, and the difference is the
 * whole point. That script calls `dispatchUrgentNotification` in-process, so
 * it exercises the Node dispatcher in src/lib/notifications/dispatch.ts. This
 * one POSTs a `coworker_logs`-shaped webhook body to
 * `${SUPABASE_URL}/functions/v1/notifications`, so it exercises the deployed
 * Deno mirror instead: a different runtime, a different copy of the fan-out,
 * a different preferences reader, and the /api/internal/push-send bridge in
 * between. `tsconfig.json` excludes supabase/functions, so that pipeline is
 * the half the compiler never sees.
 *
 * This is not a simulation. The edge function fans out to every channel the
 * business has enabled, so running it sends a genuine SMS and a genuine email
 * alongside the push, and writes real `notifications` rows. Only ever point
 * it at a business you own.
 *
 * Attribution is exact rather than inferred: every row the dispatcher writes
 * for one alert carries `payload.logId`, which is the id minted here and sent
 * in the webhook body. So the rows this prints are provably the ones THIS
 * POST caused, not whatever else happened to land in the same minute.
 *
 * With --watch it then waits for the notification to be tapped and reports
 * whether the receipt bound to the row. That last step is what proves the
 * edge path carries a notification id at all: a push delivered without one
 * still shows a banner and still records a click, but `markNotificationRead`
 * never fires and the click row lands with a null notification_id, so the
 * read receipt this channel exists for is silently missing.
 *
 * Usage: tsx debug/push-edge-alert.ts <businessId> [taskType] [--watch]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const positional = args.filter((a) => !a.startsWith("--"));
const businessId = positional[0];
// Defaults to a task_type with no special summary template and no contact
// scoping, so nothing dedupes or coalesces the alert away.
const taskType = positional[1] ?? "voice_capture";

if (!businessId) {
  console.error("Usage: tsx debug/push-edge-alert.ts <businessId> [taskType] [--watch]");
  process.exit(1);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!supabaseUrl || !serviceKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
  process.exit(1);
}

/**
 * The bearer the EDGE function checks, which is not necessarily the one we
 * use to read the database back.
 *
 * verifyRequest accepts either the function's own SUPABASE_SERVICE_ROLE_KEY
 * or NOTIFICATIONS_WEBHOOK_TOKEN. Those are Edge Function Secrets, set
 * independently of this repo's .env, so the local service-role key can be a
 * perfectly good database credential and still be rejected at the function.
 * Prefer the webhook token, which exists for exactly this kind of script
 * call, and fall back to the service key.
 */
const webhookToken = (process.env.NOTIFICATIONS_WEBHOOK_TOKEN ?? "").trim();
const edgeBearer = webhookToken || serviceKey;

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

/** Deliverable devices BEFORE the send, so `devices_sent` has something to be right about. */
const { data: subsBefore, error: subsErr } = await db
  .from("push_subscriptions")
  .select("id, device_label, endpoint")
  .is("revoked_at", null)
  .eq("business_id", businessId);
if (subsErr) {
  console.error("could not read push_subscriptions:", subsErr.message);
  process.exit(1);
}
const expectedDevices = subsBefore?.length ?? 0;

const logId = crypto.randomUUID();
const notifyUrl = `${supabaseUrl}/functions/v1/notifications`;

console.log(`edge fn : ${notifyUrl}`);
console.log(`bearer  : ${webhookToken ? "NOTIFICATIONS_WEBHOOK_TOKEN" : "SUPABASE_SERVICE_ROLE_KEY"}`);
console.log(`business: ${businessId}`);
console.log(`taskType: ${taskType}`);
console.log(`logId   : ${logId}   (every row this alert writes carries it)`);
console.log(`devices : ${expectedDevices} deliverable subscription(s) before the send`);
for (const s of subsBefore ?? []) {
  console.log(`          ${s.device_label} via ${new URL(s.endpoint).host}`);
}
console.log("");

const res = await fetch(notifyUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${edgeBearer}`
  },
  body: JSON.stringify({
    type: "INSERT",
    table: "coworker_logs",
    record: {
      id: logId,
      business_id: businessId,
      task_type: taskType,
      status: "urgent_alert",
      log_payload: { source: "debug/push-edge-alert" },
      created_at: new Date().toISOString()
    }
  })
});

const bodyText = await res.text();
console.log(`edge response: HTTP ${res.status} ${bodyText}`);
console.log("");

if (!res.ok) {
  console.error("the edge function rejected the request; no rows to read back");
  process.exit(1);
}

/**
 * The function writes its rows during the request, but the insert and the
 * response race on a bad day, so read back with a couple of retries rather
 * than reporting an empty result as a failed dispatch.
 */
type Row = {
  id: string;
  delivery_channel: string;
  status: string;
  read_at: string | null;
  payload: Record<string, unknown> | null;
};
let rows: Row[] = [];
for (let attempt = 0; attempt < 5; attempt += 1) {
  const { data, error } = await db
    .from("notifications")
    .select("id, delivery_channel, status, read_at, payload")
    .eq("business_id", businessId)
    .eq("payload->>logId", logId);
  if (error) {
    console.error("read-back failed:", error.message);
    process.exit(1);
  }
  rows = (data ?? []) as Row[];
  if (rows.length > 0) break;
  await new Promise((r) => setTimeout(r, 1000));
}

if (rows.length === 0) {
  console.error("NO ROWS carry this logId, so the edge function wrote nothing for this alert");
  process.exit(1);
}

console.log("rows written by the EDGE dispatcher:");
for (const row of rows.sort((a, b) => a.delivery_channel.localeCompare(b.delivery_channel))) {
  const reason = row.payload?.reason ? `  (${String(row.payload.reason)})` : "";
  const recipient = row.payload?.recipient ? `  to ${String(row.payload.recipient)}` : "";
  console.log(`  ${row.status.padEnd(8)} ${row.delivery_channel.padEnd(12)}${recipient}${reason}`);
}
console.log("");

const push = rows.find((r) => r.delivery_channel === "push");
if (!push) {
  console.error("FAIL: the edge dispatcher wrote no push row at all.");
  console.error("      Either the deployed function predates the push leg, or the");
  console.error("      business has no live subscription and it silently sat out.");
  process.exit(1);
}

const sentDevices = Number(push.payload?.devices_sent ?? 0);
console.log(`push row : ${push.status}, id ${push.id}`);
console.log(`devices  : ${sentDevices} sent, ${Number(push.payload?.devices_revoked ?? 0)} revoked`);
if (push.status !== "sent") {
  console.error(`FAIL: push did not send (${String(push.payload?.reason ?? "no reason recorded")})`);
  process.exit(1);
}
if (sentDevices !== expectedDevices) {
  console.error(`FAIL: expected ${expectedDevices} device(s), the bridge reported ${sentDevices}`);
  process.exit(1);
}
console.log("PASS: the deployed edge function delivered a push through the bridge.");

if (!watch) {
  console.log("");
  console.log("Re-run with --watch to also prove the tap receipt binds to this row.");
  process.exit(0);
}

/**
 * The receipt half. A push whose payload carries no notification id still
 * delivers and is still tappable, and the click is still recorded, so the
 * ONLY way to tell the two apart from outside is to tap it and ask whether
 * anything bound to the row.
 */
console.log("");
console.log(`Waiting for a tap on that notification (id ${push.id})...`);
console.log("Tap the banner on the device. Ctrl-C to give up.");

const deadline = Date.now() + 180_000;
for (;;) {
  if (Date.now() > deadline) {
    console.error("");
    console.error("TIMED OUT with no bound receipt after 3 minutes.");
    console.error("If you DID tap it, check notification_link_clicks for a push row with a");
    console.error("null notification_id: that is the edge leg delivering without an id.");
    process.exit(1);
  }

  const { data: clicks } = await db
    .from("notification_link_clicks")
    .select("id, channel, notification_id, likely_prefetch, created_at")
    .eq("channel", "push")
    .eq("notification_id", push.id);

  if ((clicks ?? []).length > 0) {
    const { data: after } = await db
      .from("notifications")
      .select("read_at, read_by_actor")
      .eq("id", push.id)
      .maybeSingle();
    console.log("");
    console.log(`click row  : ${JSON.stringify(clicks?.[0])}`);
    console.log(`row read_at: ${after?.read_at ?? "NOT SET"} by ${after?.read_by_actor ?? "-"}`);
    if (!after?.read_at) {
      console.error("FAIL: the click bound to the row but read_at never got stamped.");
      process.exit(1);
    }
    console.log("");
    console.log("PASS: the tap on an EDGE-dispatched push bound to its notifications row");
    console.log("      and marked it read. The receipt closes on the Deno pipeline.");
    process.exit(0);
  }

  await new Promise((r) => setTimeout(r, 3000));
}
