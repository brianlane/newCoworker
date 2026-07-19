/**
 * Retire the "Residency Pilot (internal)" tenant completely.
 *
 * The pilot (created Jul 7 2026) validated the data-residency stack on pooled
 * box srv1800985. The box was released to the adopt pool and re-imaged for a
 * real tenant on Jul 14; the pilot's business row survived only because its
 * `hostinger_vps_id` had already been detached, so the adopt-time stale-tenant
 * cascade never matched it. Nothing external bills or depends on it anymore:
 * no Stripe subscription, no Hostinger box, no Telnyx DID, no auth user.
 *
 * What this removes (in order):
 *   1. Supabase Storage: every encrypted residency DR dump under
 *      business-backups/residency/<businessId>/ (worthless ciphertext once
 *      the `residency_backup_keys` row cascades with the business row).
 *   2. Cloudflare: the orphaned per-tenant tunnel `nc-<businessId>` and its
 *      CNAMEs (`<id>`, `voice-<id>`, `render-<id>`, `data-<id>`) — no code
 *      path deletes tunnels, so these outlived the box.
 *   3. Postgres: the `businesses` row — ON DELETE CASCADE fans out to the
 *      config, contact, logs, gateway token, residency backup key, and the
 *      canceled Stripe-less subscription row. `applied_oneshots` /
 *      `telnyx_cost_daily` FKs are SET NULL (ledgers preserved by design).
 *
 * Fail-closed guards: aborts unless the row still matches the expected name,
 * has no Stripe subscription id, no `hostinger_vps_id`, and is not any
 * `vps_inventory.assigned_business_id`.
 *
 * Usage (repo-root .env sourced):
 *   npx tsx scripts/oneshot/retire-residency-pilot.ts          # dry run
 *   npx tsx scripts/oneshot/retire-residency-pilot.ts --apply
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { recordOneshotApplied } from "./_ledger";

const BUSINESS_ID = "7e2b9d4a-1f3c-4e5d-9a6b-8c7d0e1f2a3b";
const EXPECTED_NAME = "Residency Pilot (internal)";
const BACKUP_BUCKET = "business-backups";
const BACKUP_PREFIX = `residency/${BUSINESS_ID}`;
const CF_API = "https://api.cloudflare.com/client/v4";

const apply = process.argv.includes("--apply");
const tag = apply ? "APPLY" : "DRY";

type CfEnvelope<T> = {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
};

async function cf<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const body = (await res.json()) as CfEnvelope<T>;
  if (!body.success) {
    const msg = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`Cloudflare ${path} failed: ${msg || `status ${res.status}`}`);
  }
  return body.result;
}

async function assertGuards(db: SupabaseClient): Promise<void> {
  const { data: biz, error } = await db
    .from("businesses")
    .select("id, name, hostinger_vps_id")
    .eq("id", BUSINESS_ID)
    .maybeSingle();
  if (error) throw new Error(`businesses read failed: ${error.message}`);
  if (!biz) throw new Error(`business ${BUSINESS_ID} not found — already retired?`);
  if (biz.name !== EXPECTED_NAME) {
    throw new Error(`guard: name is ${JSON.stringify(biz.name)}, expected ${JSON.stringify(EXPECTED_NAME)}`);
  }
  if (biz.hostinger_vps_id !== null) {
    throw new Error(`guard: business still points at VPS ${biz.hostinger_vps_id}`);
  }

  const { data: subs, error: subErr } = await db
    .from("subscriptions")
    .select("id, status, stripe_subscription_id")
    .eq("business_id", BUSINESS_ID);
  if (subErr) throw new Error(`subscriptions read failed: ${subErr.message}`);
  for (const sub of subs ?? []) {
    if (sub.stripe_subscription_id !== null) {
      throw new Error(`guard: subscription ${sub.id} is Stripe-linked (${sub.status})`);
    }
  }

  const { data: inv, error: invErr } = await db
    .from("vps_inventory")
    .select("vm_id")
    .eq("assigned_business_id", BUSINESS_ID);
  if (invErr) throw new Error(`vps_inventory read failed: ${invErr.message}`);
  if ((inv ?? []).length > 0) {
    throw new Error(`guard: vps_inventory still assigns VM(s) to this business: ${inv!.map((r) => r.vm_id).join(", ")}`);
  }
  console.log(`${tag} guards passed: Stripe-less, VPS-less, not in the adopt pool.`);
}

async function purgeStorageDumps(db: SupabaseClient): Promise<number> {
  const names: string[] = [];
  // Storage list() is per-"directory"; the dumps live flat under the prefix.
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await db.storage
      .from(BACKUP_BUCKET)
      .list(BACKUP_PREFIX, { limit: 100, offset });
    if (error) throw new Error(`storage list failed: ${error.message}`);
    const page = data ?? [];
    names.push(...page.map((o) => `${BACKUP_PREFIX}/${o.name}`));
    if (page.length < 100) break;
  }
  console.log(`${tag} storage: ${names.length} object(s) under ${BACKUP_BUCKET}/${BACKUP_PREFIX}/`);
  if (names.length === 0 || !apply) return names.length;
  const { error } = await db.storage.from(BACKUP_BUCKET).remove(names);
  if (error) throw new Error(`storage remove failed: ${error.message}`);
  console.log(`${tag} storage: deleted ${names.length} object(s).`);
  return names.length;
}

async function cleanupCloudflare(): Promise<{ dnsDeleted: number; tunnelDeleted: boolean }> {
  const token = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  if (!token || !accountId) {
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID required (source the repo-root .env)");
  }
  const zoneName = (process.env.CLOUDFLARE_TUNNEL_ZONE ?? "").trim() || "newcoworker.com";
  let zoneId = (process.env.CLOUDFLARE_ZONE_ID ?? "").trim();
  if (!zoneId) {
    const zones = await cf<Array<{ id: string }>>(token, `/zones?name=${encodeURIComponent(zoneName)}`);
    if (!zones?.[0]) throw new Error(`zone ${zoneName} not found`);
    zoneId = zones[0].id;
  }

  // DNS records: same hostname shapes the provisioner creates. render- and
  // data- existed for this enterprise+residency tenant; missing records are
  // simply skipped.
  const hostnames = ["", "voice-", "render-", "data-"].map(
    (prefix) => `${prefix}${BUSINESS_ID}.${zoneName}`
  );
  let dnsDeleted = 0;
  for (const hostname of hostnames) {
    const records = await cf<Array<{ id: string; name: string }>>(
      token,
      `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`
    );
    for (const record of records ?? []) {
      console.log(`${tag} cloudflare DNS: delete CNAME ${record.name} (${record.id})`);
      if (apply) {
        await cf(token, `/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" });
      }
      dnsDeleted++;
    }
  }
  if (dnsDeleted === 0) console.log(`${tag} cloudflare DNS: no pilot CNAMEs found.`);

  // Tunnel: named nc-<businessId> by the provisioner. is_deleted=false skips
  // tombstones of previously deleted tunnels. cascade=true tears down any
  // stale connections/routes (the box was re-imaged, so none should be live).
  const tunnelName = `nc-${BUSINESS_ID}`;
  const tunnels = await cf<Array<{ id: string; name: string }>>(
    token,
    `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`
  );
  let tunnelDeleted = false;
  for (const tunnel of tunnels ?? []) {
    console.log(`${tag} cloudflare tunnel: delete ${tunnel.name} (${tunnel.id})`);
    if (apply) {
      await cf(token, `/accounts/${accountId}/cfd_tunnel/${tunnel.id}?cascade=true`, {
        method: "DELETE"
      });
    }
    tunnelDeleted = true;
  }
  if (!tunnelDeleted) console.log(`${tag} cloudflare tunnel: ${tunnelName} not found (already gone).`);
  return { dnsDeleted, tunnelDeleted };
}

async function deleteBusinessRow(db: SupabaseClient): Promise<void> {
  console.log(`${tag} db: delete businesses row ${BUSINESS_ID} (ON DELETE CASCADE fans out)`);
  if (!apply) return;
  const { error } = await db.from("businesses").delete().eq("id", BUSINESS_ID);
  if (error) throw new Error(`businesses delete failed: ${error.message}`);
  console.log(`${tag} db: business row deleted.`);
}

async function main() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  await assertGuards(db);
  const dumpsDeleted = await purgeStorageDumps(db);
  const cfResult = await cleanupCloudflare();
  await deleteBusinessRow(db);

  if (apply) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "retire-residency-pilot.ts",
      // The business row is gone; the ledger column is SET NULL on cascade
      // anyway, so record it in details instead.
      businessId: null,
      details: {
        retiredBusinessId: BUSINESS_ID,
        name: EXPECTED_NAME,
        storageDumpsDeleted: dumpsDeleted,
        cloudflareDnsRecordsDeleted: cfResult.dnsDeleted,
        cloudflareTunnelDeleted: cfResult.tunnelDeleted
      }
    });
    console.log("APPLY complete — Residency Pilot fully retired.");
  } else {
    console.log("DRY run complete — re-run with --apply to execute.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
