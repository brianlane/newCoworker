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
 * read current whitelisted_destinations, PATCH to the UNION of the current
 * list and the allowlist, read back and verify. The union matters: a widen
 * must be monotone. The Aug 5 2026 run REPLACED the lists with a
 * dial-table-derived allowlist that could not contain Canada (bare +1 maps
 * to US; CA has no prefix of its own), which knocked out every Canadian
 * SMS fleet-wide until Aug 6 (Telnyx 40309, "Invalid destination region
 * 'CA'"; KYP lost owner notifies and a lead follow-up). The allowlist now
 * adds prefixless regions explicitly and refuses to run without US/CA/MX
 * present (see widen-telnyx-allowlist.ts), and this script never removes
 * a region a profile already has.
 *
 * Per-DID `features.sms.international_outbound` is REPORTED
 * only: Telnyx computes it from the number's capabilities + profile; if it
 * stays false after the profile widens, escalate with Telnyx support
 * rather than guessing at undocumented PATCH fields.
 */
import { allowedCountries, assertContainsLiveTrafficRegions } from "./widen-telnyx-allowlist";
import { SMS_DESTINATION_DENYLIST } from "../../supabase/functions/_shared/sms_destination_rates";
import { loadEnv } from "../../debug/_shared";

loadEnv();

const APPLY = process.argv.includes("--apply");
const KEY = process.env.TELNYX_API_KEY ?? "";

/** Union of the allowlist and what the profile already has: widening only. */
function widened(current: string[], allowed: string[]): string[] {
  const merged = [...new Set([...current, ...allowed])].sort();
  assertContainsLiveTrafficRegions(merged);
  return merged;
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
  const target = widened(current, allowed);
  console.log(`\n[${label}] ${id}`);
  console.log(`  current whitelist: ${current.length <= 5 ? JSON.stringify(current) : current.length + " countries"}`);
  if (!APPLY) {
    console.log(`  DRY-RUN: would PATCH whitelisted_destinations to ${target.length} countries`);
    return;
  }
  const patch = await telnyx(`/messaging_profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ whitelisted_destinations: target })
  });
  if (patch.status !== 200) {
    throw new Error(`[${label}] PATCH failed: ${patch.status} ${JSON.stringify(patch.body).slice(0, 300)}`);
  }
  const after = await telnyx(`/messaging_profiles/${id}`);
  const readback: string[] = after.body?.data?.whitelisted_destinations ?? [];
  const missing = target.filter((c) => !readback.includes(c));
  console.log(`  applied: ${readback.length} countries whitelisted${missing.length ? `; MISSING ${missing.join(",")}` : ""}`);
  if (missing.length > 0) {
    throw new Error(`[${label}] readback is missing ${missing.length} countries`);
  }
}

async function widenVoiceProfiles(allowed: string[]): Promise<void> {
  const list = await telnyx("/outbound_voice_profiles");
  for (const p of list.body?.data ?? []) {
    const current: string[] = p.whitelisted_destinations ?? [];
    const target = widened(current, allowed);
    console.log(`\n[voice] ${p.id} (${p.name})`);
    console.log(`  current whitelist: ${current.length <= 5 ? JSON.stringify(current) : current.length + " countries"}`);
    if (!APPLY) {
      console.log(`  DRY-RUN: would PATCH whitelisted_destinations to ${target.length} countries`);
      continue;
    }
    const patch = await telnyx(`/outbound_voice_profiles/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify({ whitelisted_destinations: target })
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
  console.log(
    `Allowlist: ${allowed.length} countries (dial table + prefixless regions like CA, minus denylist ${[...SMS_DESTINATION_DENYLIST].sort().join(",")})`
  );
  console.log(APPLY ? "MODE: APPLY" : "MODE: dry-run (pass --apply to execute)");

  // Enumerate EVERY messaging profile from the account instead of the three
  // platform env ids: per-tenant custom profiles exist (Truly Insurance has
  // its own), and the first run of this script missed one exactly because it
  // trusted the env list. The account is the source of truth. Paginated via
  // meta.total_pages (Telnyx clamps pages; trusting one page would recreate
  // the missed-profile gap at scale).
  const profiles: Array<{ id: string; name: string }> = [];
  for (let page = 1; page <= 50; page += 1) {
    const list = await telnyx(`/messaging_profiles?page[size]=50&page[number]=${page}`);
    if (list.status !== 200) {
      throw new Error(`GET /messaging_profiles page ${page}: HTTP ${list.status}`);
    }
    for (const p of list.body?.data ?? []) profiles.push({ id: p.id, name: p.name });
    const totalPages = Number(list.body?.meta?.total_pages ?? 1);
    if (page >= totalPages) break;
  }
  if (profiles.length === 0) throw new Error("no messaging profiles returned; refusing to no-op");
  for (const p of profiles) {
    await widenMessagingProfile(p.name, p.id, allowed);
  }
  await widenVoiceProfiles(allowed);
  await reportDidFlags();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
