/**
 * set-hq-outreach-send-as.ts, make HQ's cold outreach leave as team@.
 *
 * HQ's outreach sends through the connected Gmail, which signs in as a personal
 * Google account and has `team@<tenant domain>` verified under "Send mail as".
 * Until `outreach_settings.send_as_email` existed the raw send carried no From
 * header, so the address on a pitch was whatever Gmail defaulted to rather
 * than the product's own. This writes the alias into the setting, after which
 * every pitch and follow-up nudge goes out with `From:` and `Reply-To:` set to
 * it (see sendThroughConfiguredMailbox in src/lib/outreach/sweep.ts). Replies
 * still land in the same Gmail because Cloudflare routes the whole domain
 * there, which is what keeps owned-thread reply detection working.
 *
 * Touches ONE row (HQ's) and ONE column. Every other tenant keeps the null
 * default, which is the pre-change behavior, so this cannot change anyone
 * else's mail. It refuses to run without an existing settings row rather than
 * creating one: a row created here would carry mode `off` and the migration
 * defaults, and pretending that is a configured tenant is how a later reader
 * gets misled.
 *
 * The address must already be a verified send-as identity on the connected
 * Gmail. This script cannot check that (the alias list is not exposed to us),
 * so it says so and leaves the verification to the human at the keyboard.
 * A wrong address does not break sends: Gmail rewrites an unknown From back
 * to the primary, which is exactly today's behavior.
 *
 * Idempotent: an already-matching value reports "nothing to do" and writes
 * nothing. Dry-run by default, ledger-recorded on apply.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/set-hq-outreach-send-as.ts                      # dry-run, team@<domain>
 *   npx tsx scripts/oneshot/set-hq-outreach-send-as.ts --apply              # write it
 *   npx tsx scripts/oneshot/set-hq-outreach-send-as.ts --send-as x@y.com    # another alias
 *   npx tsx scripts/oneshot/set-hq-outreach-send-as.ts --clear --apply      # back to the provider default
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const CLEAR = process.argv.includes("--clear");
const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";

function argValue(flag: string): string | null {
  const at = process.argv.indexOf(flag);
  if (at === -1) return null;
  const value = process.argv[at + 1];
  return value && !value.startsWith("--") ? value : null;
}

const { createClient } = await import("@supabase/supabase-js");
const { tenantEmailDomain } = await import("../../src/lib/email/tenant-mailbox.ts");
const { normalizeSendAsEmail } = await import("../../src/lib/outreach/send-as.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");

// The same shape check the dashboard save applies, so this cannot store a
// value the panel would refuse or the DB constraint would reject.
const requested = CLEAR ? null : (argValue("--send-as") ?? `team@${tenantEmailDomain()}`);
const target = requested === null ? null : normalizeSendAsEmail(requested);
if (target === "invalid") {
  console.error(`Refusing: "${requested}" is not shaped like a single email address.`);
  process.exit(1);
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: settings, error: readError } = await db
  .from("outreach_settings")
  .select("business_id, mode, from_connection_id, send_as_email")
  .eq("business_id", HQ_BUSINESS_ID)
  .maybeSingle();
if (readError) throw new Error(`read outreach_settings: ${readError.message}`);
if (!settings) {
  console.error(
    "Refusing: HQ has no outreach_settings row. Run configure-hq-prospecting.ts first; " +
      "this script only changes the send-as address on an existing configuration."
  );
  process.exit(1);
}

const current = (settings as { send_as_email: string | null }).send_as_email ?? null;
console.log(`Business: HQ (${HQ_BUSINESS_ID})`);
console.log(`Mode: ${(settings as { mode: string }).mode}`);
console.log(
  `Mailbox: ${(settings as { from_connection_id: string | null }).from_connection_id ?? "Automatic (whichever is connected)"}`
);
console.log(`send_as_email now: ${current ?? "(null, provider default)"}`);
console.log(`send_as_email after: ${target ?? "(null, provider default)"}`);
if (target) {
  console.log(
    `\nThis script cannot see Gmail's alias list. Confirm "${target}" is listed and VERIFIED ` +
      "under Gmail Settings, Accounts and Import, Send mail as, on the connected account, " +
      "and that mail to it lands in that same inbox."
  );
}

if (current === target) {
  console.log("\nNothing to do: the stored value already matches.");
  process.exit(0);
}

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write.");
  process.exit(0);
}

// Read the write back rather than trusting a no-error UPDATE: a filter that
// matches zero rows returns no error either.
const { data: written, error: writeError } = await db
  .from("outreach_settings")
  .update({ send_as_email: target, updated_at: new Date().toISOString() })
  .eq("business_id", HQ_BUSINESS_ID)
  .select("send_as_email")
  .maybeSingle();
if (writeError) throw new Error(`write outreach_settings: ${writeError.message}`);
const landed = (written as { send_as_email: string | null } | null)?.send_as_email ?? null;
if (landed !== target) {
  throw new Error(`write did not land: read back ${landed ?? "null"}, expected ${target ?? "null"}`);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: HQ_BUSINESS_ID,
  details: { send_as_email_before: current, send_as_email_after: target }
});

console.log("\nApplied. Takes effect on the next send: the sweep reads settings per pass.");
console.log("Verify on the first pitch after this: open it in the recipient view (or Gmail Sent)");
console.log(`and check the From line reads ${target ?? "the mailbox's default"}.`);
