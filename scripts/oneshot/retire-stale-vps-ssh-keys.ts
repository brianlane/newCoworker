#!/usr/bin/env tsx
/**
 * One-shot: stamp `rotated_at` on the `vps_ssh_keys` rows that belong to boxes
 * we no longer run, so the fleet sweeps stop trying to SSH into dead hardware.
 *
 * Why: a row is retired by stamping `rotated_at` (see `rotateVpsSshKey` in
 * src/lib/db/vps-ssh-keys.ts), and the only caller today is the VPS-adoption
 * path, which rotates a row it is about to REPLACE for the same box. Nothing
 * rotates a row when a tenant simply moves to different hardware: the old
 * row keeps `rotated_at IS NULL` forever, because the partial unique index
 * is per-VPS (`vps_ssh_keys_one_active_per_vps`) and a new box is a new key,
 * so the insert never collides and never triggers a rotation.
 *
 * The visible symptom is that every fleet sweep tries the dead boxes and
 * reports failures that are not failures. On 2026-08-14 a chat-worker rollout
 * printed "4/9 succeeded" with five `ssh-failed: Timed out while waiting for
 * handshake`, all five superseded boxes, while all four live tenants updated
 * cleanly. A rollout that always reports failures is a rollout nobody reads.
 *
 * Eligibility, all four required:
 *   1. `rotated_at IS NULL` (the row is still considered active),
 *   2. `provider = 'hostinger'` (the only provider this script can verify;
 *      ovh/byos rows are reported and left alone),
 *   3. the box is NOT the tenant's current box in `businesses.hostinger_vps_id`,
 *   4. the live Hostinger API reports the box `stopped` or `suspended` (an
 *      allow-list, see DEAD_STATES: a box mid-provision is `initial` or
 *      `installing`, and retiring its key would strand the tenant).
 *
 * Plus one invariant that overrides all of the above: **never rotate a
 * business's last active row.** `getActiveVpsSshKeyForBusiness` returns null
 * when every row is rotated, which would break break-glass console access and
 * every redeploy path for that tenant.
 *
 * Safety: dry-run by default; prints every row with its verdict and reason.
 * Idempotent, because a rotated row no longer matches the `rotated_at IS NULL`
 * read. Non-destructive and reversible: the keypair stays in the row, so
 * restarting a suspended box only needs the stamp cleared again.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/retire-stale-vps-ssh-keys.ts            # dry run
 *   npx tsx scripts/oneshot/retire-stale-vps-ssh-keys.ts --apply
 */
import { loadEnv, makeHostingerClient } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");

const APPLY = process.argv.includes("--apply");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Source .env first.");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

/**
 * States that mean the box is genuinely not running our worker. Deliberately
 * an ALLOW-list: `VirtualMachineState` also carries `initial`, `installing`
 * and `error`, and a deny-list of just `running` would retire a box that is
 * mid-provision.
 *
 * That window is real, not theoretical. On the adopt path
 * (src/lib/hostinger/adopt.ts) the key row is inserted BEFORE the destructive
 * recreate, so the VM passes through `initial`/`installing` while its row is
 * already active and `businesses.hostinger_vps_id` still points at the old
 * box. Both of this script's other guards are satisfied in that window, so a
 * deny-list would stamp `rotated_at` on the key for the box being brought up
 * and strand the tenant after cutover. (The fresh-purchase path is safe
 * either way: it inserts the key only after `waitForVpsReady` sees `running`.)
 *
 * Anything outside this list, including a state Hostinger adds later, is held
 * back for a human rather than retired.
 */
const DEAD_STATES = new Set(["stopped", "suspended"]);

type KeyRow = {
  id: string;
  business_id: string;
  hostinger_vps_id: string;
  provider: string;
  created_at: string;
};

// Never select private_key_pem: this script has no use for it and a stray
// console.log of a row would leak every tenant's box credentials.
const { data: keyData, error: keyErr } = await db
  .from("vps_ssh_keys")
  .select("id, business_id, hostinger_vps_id, provider, created_at")
  .is("rotated_at", null)
  .order("created_at", { ascending: false });
if (keyErr) throw new Error(`read vps_ssh_keys: ${keyErr.message}`);
const rows = (keyData ?? []) as KeyRow[];

console.log(`vps_ssh_keys: ${rows.length} active (unrotated) row(s)`);
if (rows.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

const { data: bizData, error: bizErr } = await db
  .from("businesses")
  .select("id, name, hostinger_vps_id")
  .not("hostinger_vps_id", "is", null);
if (bizErr) throw new Error(`read businesses: ${bizErr.message}`);
type BizRow = { id: string; name: string | null; hostinger_vps_id: string | null };
const businesses = (bizData ?? []) as BizRow[];

/** The box each tenant is actually on right now. This is the authority. */
const currentVpsIds = new Set(
  businesses.map((b) => String(b.hostinger_vps_id)).filter((v) => v && v !== "null")
);
const businessName = new Map(businesses.map((b) => [b.id, b.name ?? b.id]));

/** Live provider state, so "superseded" is never inferred from our own tables alone. */
const vms = await makeHostingerClient().listVirtualMachines();
const vmState = new Map(vms.map((v) => [String(v.id), String(v.state)]));

/** Active rows per business, so we can refuse to empty one out. */
const activeCountByBusiness = new Map<string, number>();
for (const row of rows) {
  activeCountByBusiness.set(row.business_id, (activeCountByBusiness.get(row.business_id) ?? 0) + 1);
}

const eligible: Array<{ row: KeyRow; state: string }> = [];
const held: Array<{ row: KeyRow; why: string }> = [];

for (const row of rows) {
  const vpsId = String(row.hostinger_vps_id);
  const state = vmState.get(vpsId);

  if (row.provider !== "hostinger") {
    held.push({ row, why: `provider '${row.provider}' cannot be verified by this script` });
    continue;
  }
  if (currentVpsIds.has(vpsId)) {
    held.push({ row, why: "current box in businesses.hostinger_vps_id" });
    continue;
  }
  if (state === undefined) {
    // Absent from the account is ambiguous (deleted box, or a token that can
    // no longer see it). Report it; a human decides.
    held.push({ row, why: "absent from the Hostinger account; verify by hand" });
    continue;
  }
  if (!DEAD_STATES.has(state)) {
    held.push({ row, why: `Hostinger reports state='${state}'; only ${[...DEAD_STATES].join("/")} retire` });
    continue;
  }
  if ((activeCountByBusiness.get(row.business_id) ?? 0) <= 1) {
    held.push({ row, why: "last active row for this business; rotating it would orphan the tenant" });
    continue;
  }

  eligible.push({ row, state });
  // Keep the running tally honest so a business can never be emptied by the
  // cumulative effect of several rotations in the same pass.
  activeCountByBusiness.set(row.business_id, (activeCountByBusiness.get(row.business_id) ?? 1) - 1);
}

const label = (row: KeyRow) =>
  `vps=${String(row.hostinger_vps_id).padEnd(9)} ${String(businessName.get(row.business_id)).slice(0, 28).padEnd(28)} created=${row.created_at.slice(0, 10)}`;

console.log(`\nEligible to retire: ${eligible.length}`);
for (const { row, state } of eligible) {
  console.log(`  ${label(row)}  hostinger=${state}`);
}
if (held.length > 0) {
  console.log(`\nHeld back: ${held.length}`);
  for (const { row, why } of held) {
    console.log(`  ${label(row)}  ${why}`);
  }
}

if (eligible.length === 0) {
  console.log("\nNothing eligible to retire.");
  process.exit(0);
}

if (!APPLY) {
  console.log("\nDRY RUN. Re-run with --apply to stamp rotated_at on the eligible rows.");
  process.exit(0);
}

const rotatedAt = new Date().toISOString();
let updated = 0;
for (const { row } of eligible) {
  // .select() the write back: a PostgREST update that matches zero rows
  // returns no error, so without this a no-op would report as success.
  const { data, error } = await db
    .from("vps_ssh_keys")
    .update({ rotated_at: rotatedAt })
    .eq("id", row.id)
    .is("rotated_at", null)
    .select("id");
  if (error) {
    console.error(`\nUpdate failed after ${updated} row(s): ${error.message}`);
    process.exit(1);
  }
  if ((data ?? []).length === 0) {
    console.error(`\nRow ${row.id} matched nothing (already rotated?). Stopping.`);
    process.exit(1);
  }
  updated += 1;
  console.log(`  retired ${updated}/${eligible.length}  ${label(row)}`);
}

await recordOneshotApplied(db, {
  // Fleet-wide bookkeeping across several tenants, so no single business_id.
  scriptPath: process.argv[1],
  businessId: null,
  details: {
    retired: updated,
    held: held.length,
    rotated_at: rotatedAt,
    vps_ids: eligible.map((e) => e.row.hostinger_vps_id),
    states: Object.fromEntries(eligible.map((e) => [e.row.hostinger_vps_id, e.state]))
  }
});

console.log(`\nDone. Retired ${updated} stale row(s); ${held.length} held back.`);
