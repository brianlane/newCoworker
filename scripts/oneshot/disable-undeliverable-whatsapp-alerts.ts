/**
 * disable-undeliverable-whatsapp-alerts.ts: turn OFF the owner-alert WhatsApp
 * leg for a tenant whose WABA provably cannot deliver one, and only then.
 *
 * The situation it was written for (KYP Ads, Aug 2026). Every
 * business-initiated send on that WABA fails with Meta error 131042,
 * "Business eligibility payment issue", which is billing rather than
 * verification, and James has told us he is not fixing it: Meta will not
 * accept his Canadian payment method. Nineteen consecutive owner alerts to
 * his own WhatsApp thread were accepted by Meta and then dropped. Each one
 * cost a `sent` notification row that was not true, a daily
 * `whatsapp_message_failed` row on the admin System Errors card, and nothing
 * a human could act on, because the fix is the customer's and he has
 * declined it. An alarm nobody can act on is how an alert channel dies.
 *
 * WHAT THIS DOES NOT TOUCH. Only `notification_preferences.whatsapp_urgent`,
 * which gates the OWNER-ALERT leg in `src/lib/notifications/dispatch.ts` and
 * its Deno mirror. The WhatsApp integration stays connected and inbound
 * customer conversations keep working exactly as before: those are
 * customer-initiated, so they run inside the free 24-hour window that
 * billing cannot block, which is why this tenant's live lead threads are
 * healthy while its alerts are not. AiFlow `send_whatsapp` steps are also
 * untouched (KYP has none).
 *
 * THE BAR, and why each half of it is here. Disabling a channel is muting,
 * and muting a channel that could work is the worse error, so every check
 * below is a refusal rather than a warning and there is deliberately no
 * override flag. A human who disagrees can flip the toggle in the dashboard.
 *
 *   1. The owner's thread must have NEVER received an inbound message. This
 *      is the load-bearing one. An inbound message opens a 24-hour window in
 *      which an alert goes out free-form and unbilled, so 131042 cannot block
 *      it: a tenant whose owner texts in sometimes has a working path and
 *      must keep the channel. KYP's thread reads a literal epoch-zero
 *      `last_user_message_at`, meaning the window has never once been open,
 *      so no alert could ever have landed.
 *   2. At least MIN_RECEIPTS receipted sends, so a quiet tenant is never
 *      judged on one or two data points.
 *   3. EVERY receipt failed. One delivery is proof the channel works.
 *   4. Every failure carries a code in PERMANENT_CODES. A transient or
 *      unknown failure is not grounds for muting; it is grounds for looking.
 *
 * Usage (ids from argv or env, never hard-coded):
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/disable-undeliverable-whatsapp-alerts.ts --business <uuid>
 *   ... --apply   # write
 *
 * Idempotent: a tenant already switched off reports "no change" and exits 0.
 * Dry-run by default. Ledger-recorded on apply.
 *
 * RETIRE THIS when the tenant's billing is fixed. Re-enabling is the same
 * toggle in Dashboard > Settings > Notifications, and the delivery receipts
 * (`npx tsx debug/whatsapp-delivery-report.ts`) are how you confirm it took.
 */
import { loadEnv } from "../../debug/_shared.ts";
import { usableSignal } from "../../src/lib/notifications/channel-liveness.ts";
import { toWaId } from "../../src/lib/whatsapp/deliver.ts";

loadEnv();

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const APPLY = process.argv.includes("--apply");
const BUSINESS_ID = argValue("--business") ?? process.env.WHATSAPP_ALERTS_BUSINESS_ID;

/**
 * Meta failure codes that describe a STATE rather than an incident, so the
 * next send is certain to fail the same way until a human outside our system
 * changes something.
 *
 * Only 131042 so far. Resist widening this to the generic delivery failures
 * (131026 undeliverable, 131047 re-engagement) which are per-recipient or
 * per-moment: muting a whole channel on one of those would hide a fault that
 * fixes itself.
 */
const PERMANENT_CODES = new Set(["131042"]);

/** Receipts needed before "all of them failed" means anything. */
const MIN_RECEIPTS = 5;

function fail(message: string): never {
  console.error(`[oneshot] ${message}`);
  process.exit(1);
}

if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  fail("pass --business <uuid> (or set WHATSAPP_ALERTS_BUSINESS_ID)");
}

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: biz, error: bizErr } = await db
  .from("businesses")
  .select("id, name")
  .eq("id", BUSINESS_ID)
  .maybeSingle();
if (bizErr || !biz) {
  fail(`business not found: ${bizErr?.message ?? BUSINESS_ID}`);
}
console.log(`[oneshot] business: ${biz.name} (${BUSINESS_ID})`);

const { data: prefs, error: prefsErr } = await db
  .from("notification_preferences")
  .select("business_id, phone_number, whatsapp_urgent")
  .eq("business_id", BUSINESS_ID)
  .maybeSingle();
if (prefsErr) {
  fail(`notification_preferences read failed: ${prefsErr.message}`);
}
if (!prefs) {
  fail("no notification_preferences row: nothing is configured to disable");
}
if (prefs.whatsapp_urgent === false) {
  console.log("[oneshot] whatsapp_urgent is already false. Nothing to do.");
  process.exit(0);
}

const ownerPhone = String(prefs.phone_number ?? "").trim();
if (!ownerPhone) {
  fail("no alert phone on notification_preferences: there is no owner thread to judge");
}
const ownerWaId = toWaId(ownerPhone);
if (!ownerWaId) {
  fail(`alert phone ${ownerPhone} does not coerce to a wa_id`);
}

// The connection has to exist, or the leg is already inert and disabling the
// toggle would record a decision about nothing.
const { data: connection, error: connErr } = await db
  .from("whatsapp_connections")
  .select("business_id, is_active")
  .eq("business_id", BUSINESS_ID)
  .maybeSingle();
if (connErr) {
  fail(`whatsapp_connections read failed: ${connErr.message}`);
}
if (!connection?.is_active) {
  fail(
    "WhatsApp is not connected (or not active) for this business, so the alert leg " +
      "already records an honest skip. Nothing here to mute."
  );
}

// The OWNER's thread specifically, matched by psid. Reading the newest thread
// of any kind would judge the channel on a lead's conversation, which on this
// tenant is exactly the mistake that made WhatsApp look alive for weeks.
const { data: thread, error: threadErr } = await db
  .from("messenger_conversations")
  .select("id, psid, last_user_message_at")
  .eq("business_id", BUSINESS_ID)
  .eq("platform", "whatsapp")
  .eq("psid", ownerWaId)
  .maybeSingle();
if (threadErr) {
  fail(`messenger_conversations read failed: ${threadErr.message}`);
}
if (!thread) {
  fail(`no WhatsApp thread for the owner's number (wa_id ${ownerWaId}): no evidence either way`);
}

// Check 1, the load-bearing one. `usableSignal` is the product's own reader
// for this, and it is what turns a literal epoch-zero stamp (a thread that
// exists but has never received anything) into the honest "never".
const inboundEver = usableSignal(thread.last_user_message_at as string | null);
if (inboundEver) {
  fail(
    `the owner has messaged this thread (last inbound ${inboundEver}), which opens a ` +
      "24-hour window where alerts go out free-form and unbilled. That path works, so " +
      "the channel must stay on."
  );
}

const { data: messages, error: msgErr } = await db
  .from("messenger_messages")
  .select("id, delivery_status, delivery_error_code, delivery_error_title, created_at")
  .eq("business_id", BUSINESS_ID)
  .eq("conversation_id", thread.id)
  .not("delivery_status", "is", null)
  .order("created_at", { ascending: false })
  .limit(200);
if (msgErr) {
  fail(`messenger_messages read failed: ${msgErr.message}`);
}
const receipts = (messages ?? []) as Array<{
  delivery_status: string;
  delivery_error_code: string | null;
  delivery_error_title: string | null;
  created_at: string;
}>;

// Check 2.
if (receipts.length < MIN_RECEIPTS) {
  fail(
    `only ${receipts.length} receipted send(s) on the owner's thread, under the ` +
      `${MIN_RECEIPTS} needed to tell a dead channel from a barely-used one`
  );
}
// Check 3.
const delivered = receipts.filter((r) => r.delivery_status !== "failed");
if (delivered.length > 0) {
  fail(
    `${delivered.length} of ${receipts.length} receipted send(s) did NOT fail ` +
      `(newest non-failure ${delivered[0].created_at}). The channel works.`
  );
}
// Check 4.
const codes = [...new Set(receipts.map((r) => r.delivery_error_code ?? "none"))];
const impermanent = codes.filter((c) => !PERMANENT_CODES.has(c));
if (impermanent.length > 0) {
  fail(
    `failure codes ${impermanent.join(", ")} are not in the permanent set ` +
      `(${[...PERMANENT_CODES].join(", ")}). A transient or unexplained failure is a ` +
      "reason to investigate, not to mute the channel."
  );
}

console.log(
  "[oneshot] evidence:",
  JSON.stringify(
    {
      ownerWaId,
      threadId: thread.id,
      inboundEver: false,
      receipts: receipts.length,
      allFailed: true,
      codes,
      title: receipts[0].delivery_error_title,
      oldest: receipts[receipts.length - 1].created_at,
      newest: receipts[0].created_at
    },
    null,
    2
  )
);
console.log(
  "[oneshot] plan: notification_preferences.whatsapp_urgent true -> false. " +
    "Owner alerts keep going by SMS, email, dashboard and push; inbound customer " +
    "WhatsApp conversations are unaffected."
);

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

// `.select()` on the write: PostgREST returns no error for an update matching
// zero rows, so the readback is the only proof the change LANDED.
const { data: written, error: writeErr } = await db
  .from("notification_preferences")
  .update({ whatsapp_urgent: false })
  .eq("business_id", BUSINESS_ID)
  .select("business_id, whatsapp_urgent");
if (writeErr) {
  fail(`notification_preferences update failed: ${writeErr.message}`);
}
if (!written || written.length !== 1) {
  fail(`update matched ${written?.length ?? 0} rows; expected exactly 1`);
}
if (written[0].whatsapp_urgent !== false) {
  fail(`readback shows whatsapp_urgent=${written[0].whatsapp_urgent}, expected false`);
}

console.log("[oneshot] applied:", JSON.stringify(written[0], null, 2));

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    ownerWaId,
    threadId: thread.id,
    receipts: receipts.length,
    codes,
    reason: "every business-initiated owner alert fails permanently and no inbound has ever opened the free window"
  }
});

console.log("[oneshot] done.");
