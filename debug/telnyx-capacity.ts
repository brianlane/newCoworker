/**
 * Telnyx outbound-capacity inspector: the three stacked limits, per tenant.
 *
 * Telnyx caps concurrent outbound calls at three layers and the MINIMUM
 * wins: each connection's outbound channel_limit, each outbound voice
 * profile's concurrent_call_limit, and the account-level pool (which the
 * API does not expose; the granted number lives in
 * admin_platform_settings key telnyx_capacity, env as fallback). The 2026-08-16 incident happened
 * because nothing ever read these back: the connection sat at 2 while the
 * profile said 10. This prints all of it side by side, plus what is in
 * flight right now.
 *
 * Read-only. Safe to run against production at any time.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   tsx debug/telnyx-capacity.ts
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");

const KEY = process.env.TELNYX_API_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!KEY || !SUPABASE_URL || !SERVICE_KEY) {
  console.error("need TELNYX_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(2);
}
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function telnyx(path: string): Promise<any> {
  const res = await fetch(`https://api.telnyx.com/v2${path}`, {
    headers: { Authorization: `Bearer ${KEY}` }
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// The granted pool lives in admin_platform_settings (env is the fallback).
const { readTelnyxCapacityConfig, gateFromConfig } = await import(
  "../supabase/functions/_shared/platform_capacity.ts"
);
const capacityConfig = await readTelnyxCapacityConfig(
  db as never,
  (name) => process.env[name]
);
const accountLimit = capacityConfig.accountChannelLimit;
const headroom = capacityConfig.platformOutboundHeadroom;

const [apps, profiles, numbers] = await Promise.all([
  telnyx("/call_control_applications?page[size]=100"),
  telnyx("/outbound_voice_profiles?page[size]=100"),
  telnyx("/phone_numbers?page[size]=100")
]);

const profileById = new Map<string, any>(
  (profiles.data ?? []).map((p: any) => [String(p.id), p])
);
const didsByConnection = new Map<string, string[]>();
for (const n of numbers.data ?? []) {
  const conn = String(n.connection_id ?? "");
  didsByConnection.set(conn, [...(didsByConnection.get(conn) ?? []), n.phone_number]);
}

console.log(`account pool (admin_platform_settings telnyx_capacity): ${accountLimit}`);
console.log(`platform pre-dial gate: ${gateFromConfig(capacityConfig)} (headroom ${headroom})`);
console.log(`\n${(apps.data ?? []).length} call control app(s):`);
let committed = 0;
for (const app of apps.data ?? []) {
  const profile = profileById.get(String(app.outbound?.outbound_voice_profile_id ?? ""));
  const dids = didsByConnection.get(String(app.id)) ?? [];
  const channelLimit = app.outbound?.channel_limit ?? null;
  const ccl = profile?.concurrent_call_limit ?? null;
  const effective = Math.min(
    channelLimit ?? accountLimit,
    ccl ?? accountLimit,
    accountLimit
  );
  committed += effective;
  console.log(
    `  ${app.application_name}\n` +
      `    app ${app.id}  channel_limit=${channelLimit ?? "none"}\n` +
      `    profile ${profile?.id ?? "(none)"}  concurrent_call_limit=${ccl ?? "none"}` +
      `  daily_spend=${profile?.daily_spend_limit_enabled ? `$${profile?.daily_spend_limit}` : "off"}` +
      `  destinations=${profile?.whitelisted_destinations?.length ?? 0}\n` +
      `    DIDs: ${dids.join(", ") || "(none)"}  effective outbound cap: ${effective}`
  );
}
const orphanProfiles = (profiles.data ?? []).filter(
  (p: any) =>
    !(apps.data ?? []).some(
      (a: any) => String(a.outbound?.outbound_voice_profile_id ?? "") === String(p.id)
    )
);
if (orphanProfiles.length > 0) {
  console.log(`\n${orphanProfiles.length} profile(s) not bound to any app:`);
  for (const p of orphanProfiles) {
    console.log(`  ${p.name} (${p.id}) concurrent_call_limit=${p.concurrent_call_limit ?? "none"}`);
  }
}

const { count: outboundInFlight } = await db
  .from("voice_reservations")
  .select("id", { count: "exact", head: true })
  .eq("direction", "outbound")
  .in("state", ["pending_answer", "active"]);
const { count: inboundInFlight } = await db
  .from("voice_reservations")
  .select("id", { count: "exact", head: true })
  .eq("direction", "inbound")
  .in("state", ["pending_answer", "active"]);
console.log(
  `\nin flight now: ${outboundInFlight ?? 0} outbound, ${inboundInFlight ?? 0} inbound reservation(s)`
);
console.log(`sum of effective per-app caps: ${committed} vs account pool ${accountLimit}`);
// Owner policy: the pool stays at least 2x the fleet's committed caps.
if (committed > 0 && accountLimit < committed * 2) {
  console.log(
    `WARN: account pool ${accountLimit} is below 2x committed caps (${committed}); ` +
      `the weekly monitor will flag this and draft a raise to ${committed * 2}.`
  );
}
console.log(
  "note: the account-level pool is support-ticket-only at Telnyx; if it was raised, update the telnyx_capacity row in admin_platform_settings so the gate and this report stay truthful."
);
