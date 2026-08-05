/**
 * International SMS, Phase 2 (Telnyx side): widen the platform messaging
 * profiles and the outbound voice profile to every country the destination
 * gate knows, minus the denylist.
 *
 * Run AFTER the sms_destination_gating migration + senders are deployed:
 * the app-side multipliers, the default-closed country gate, the velocity
 * brake, and the first-country operator alert must all be live before any
 * profile can reach a new destination, or there is a window where
 * international sends meter at 1 unit with no guardrails.
 *
 *   npx tsx scripts/oneshot/widen-telnyx-destinations.ts            # dry-run
 *   npx tsx scripts/oneshot/widen-telnyx-destinations.ts --apply
 *
 * What it does per profile (TELNYX_MESSAGING_PROFILE_ID, _CA, _MX, and the
 * outbound voice profile discovered via GET /v2/outbound_voice_profiles):
 * read current whitelisted_destinations, PATCH to the allowlist, read back
 * and verify. Per-DID `features.sms.international_outbound` is REPORTED
 * only: Telnyx computes it from the number's capabilities + profile; if it
 * stays false after the profile widens, escalate with Telnyx support
 * rather than guessing at undocumented PATCH fields.
 */
import {
  SMS_DIAL_CODES,
  SMS_DESTINATION_DENYLIST
} from "../../supabase/functions/_shared/sms_destination_rates";
import { loadEnv } from "../../debug/_shared";

loadEnv();

const APPLY = process.argv.includes("--apply");
const KEY = process.env.TELNYX_API_KEY ?? "";

/** Every ISO the dial table can resolve, minus the gate's denylist. */
function allowedCountries(): string[] {
  const isos = new Set(Object.values(SMS_DIAL_CODES));
  for (const blocked of SMS_DESTINATION_DENYLIST) isos.delete(blocked);
  return [...isos].sort();
}

async function telnyx(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`https://api.telnyx.com/v2${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function widenMessagingProfile(label: string, id: string, allowed: string[]): Promise<void> {
  const before = await telnyx(`/messaging_profiles/${id}`);
  const current: string[] = before.body?.data?.whitelisted_destinations ?? [];
  console.log(`\n[${label}] ${id}`);
  console.log(`  current whitelist: ${current.length <= 5 ? JSON.stringify(current) : current.length + " countries"}`);
  if (!APPLY) {
    console.log(`  DRY-RUN: would PATCH whitelisted_destinations to ${allowed.length} countries`);
    return;
  }
  const patch = await telnyx(`/messaging_profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ whitelisted_destinations: allowed })
  });
  if (patch.status !== 200) {
    throw new Error(`[${label}] PATCH failed: ${patch.status} ${JSON.stringify(patch.body).slice(0, 300)}`);
  }
  const after = await telnyx(`/messaging_profiles/${id}`);
  const readback: string[] = after.body?.data?.whitelisted_destinations ?? [];
  const missing = allowed.filter((c) => !readback.includes(c));
  console.log(`  applied: ${readback.length} countries whitelisted${missing.length ? `; MISSING ${missing.join(",")}` : ""}`);
  if (missing.length > 0) {
    throw new Error(`[${label}] readback is missing ${missing.length} countries`);
  }
}

async function widenVoiceProfiles(allowed: string[]): Promise<void> {
  const list = await telnyx("/outbound_voice_profiles");
  for (const p of list.body?.data ?? []) {
    console.log(`\n[voice] ${p.id} (${p.name})`);
    console.log(`  current whitelist: ${JSON.stringify(p.whitelisted_destinations)}`);
    if (!APPLY) {
      console.log(`  DRY-RUN: would PATCH whitelisted_destinations to ${allowed.length} countries`);
      continue;
    }
    const patch = await telnyx(`/outbound_voice_profiles/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify({ whitelisted_destinations: allowed })
    });
    if (patch.status !== 200) {
      throw new Error(`[voice ${p.id}] PATCH failed: ${patch.status} ${JSON.stringify(patch.body).slice(0, 300)}`);
    }
    const after = await telnyx(`/outbound_voice_profiles/${p.id}`);
    console.log(`  applied: ${after.body?.data?.whitelisted_destinations?.length ?? "?"} countries whitelisted`);
  }
}

async function reportDidFlags(): Promise<void> {
  console.log("\n[DIDs] per-number international_outbound (report-only):");
  const list = await telnyx("/phone_numbers?page[size]=50");
  for (const n of list.body?.data ?? []) {
    const m = await telnyx(`/phone_numbers/${n.id}/messaging`);
    const intl = m.body?.data?.features?.sms?.international_outbound;
    console.log(`  ${n.phone_number}: international_outbound=${intl}`);
  }
  console.log(
    "  (Telnyx derives this from number capabilities + profile; if it stays" +
      " false after widening, verify with a live send and escalate to Telnyx" +
      " support instead of guessing at undocumented fields.)"
  );
}

async function main(): Promise<void> {
  if (!KEY) throw new Error("TELNYX_API_KEY missing (repo-root .env)");
  const allowed = allowedCountries();
  console.log(`Allowlist: ${allowed.length} countries (dial table minus denylist ${[...SMS_DESTINATION_DENYLIST].sort().join(",")})`);
  console.log(APPLY ? "MODE: APPLY" : "MODE: dry-run (pass --apply to execute)");

  const profiles: Array<[string, string | undefined]> = [
    ["US default", process.env.TELNYX_MESSAGING_PROFILE_ID],
    ["CA", process.env.TELNYX_MESSAGING_PROFILE_ID_CA],
    ["MX", process.env.TELNYX_MESSAGING_PROFILE_ID_MX]
  ];
  for (const [label, id] of profiles) {
    if (!id) {
      console.log(`\n[${label}] env id unset; skipping`);
      continue;
    }
    await widenMessagingProfile(label, id, allowed);
  }
  await widenVoiceProfiles(allowed);
  await reportDidFlags();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
