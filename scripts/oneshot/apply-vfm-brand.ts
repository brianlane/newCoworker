/**
 * apply-vfm-brand.ts: teach the KYP Ads tenant's coworker its second brand,
 * Vantage Flow Media (VFM), by splicing marker-delimited sections into
 * `business_configs.identity_md` (VFM facts + the never-quote-price rule)
 * and `soul_md` (one assistant, two businesses, never ask which).
 *
 * Content lives in vfm-brand-content.ts (pure builders, pinned by
 * tests/oneshot-vfm-definitions.test.ts). This script only reads, shows the
 * rollback, writes, and syncs the vault to the tenant's box so the change
 * is live for SMS/voice rather than dormant in Supabase.
 *
 * Idempotent: the marked sections are replaced in place on re-apply.
 *
 * Usage (business id from --business or VFM_BUSINESS_ID, never hard-coded):
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/apply-vfm-brand.ts --business <uuid>          # dry-run
 *   npx tsx scripts/oneshot/apply-vfm-brand.ts --business <uuid> --apply  # write + vault sync
 */
import { loadEnv } from "../../debug/_shared.ts";
import {
  applyMarkedSection,
  buildVfmIdentitySection,
  buildVfmSoulSection,
  VFM_IDENTITY_START,
  VFM_IDENTITY_END,
  VFM_SOUL_START,
  VFM_SOUL_END
} from "./vfm-brand-content.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const businessArgIdx = process.argv.indexOf("--business");
const BUSINESS_ID =
  (businessArgIdx !== -1 ? process.argv[businessArgIdx + 1] : undefined) ??
  process.env.VFM_BUSINESS_ID;
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set VFM_BUSINESS_ID)");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const {
  BUSINESS_CONFIG_SOUL_MD_MAX_CHARS,
  BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS
} = await import("../../src/lib/vault/business-config-markdown-limits.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: row, error: fetchErr } = await db
  .from("business_configs")
  .select("business_id, soul_md, identity_md")
  .eq("business_id", BUSINESS_ID)
  .maybeSingle();

if (fetchErr || !row) {
  console.error("[oneshot] business_configs row not found:", fetchErr?.message ?? BUSINESS_ID);
  process.exit(1);
}

const nextIdentity = applyMarkedSection(
  row.identity_md ?? "",
  VFM_IDENTITY_START,
  VFM_IDENTITY_END,
  buildVfmIdentitySection()
);
const nextSoul = applyMarkedSection(
  row.soul_md ?? "",
  VFM_SOUL_START,
  VFM_SOUL_END,
  buildVfmSoulSection()
);

// Rollback artifact: both previous documents verbatim, so this run can be
// undone from its own output without going back to the database.
console.log("[oneshot] PREVIOUS identity_md (keep this for rollback):");
console.log(JSON.stringify(row.identity_md));
console.log("[oneshot] PREVIOUS soul_md (keep this for rollback):");
console.log(JSON.stringify(row.soul_md));
console.log("");
console.log("[oneshot] NEXT identity_md:");
console.log(nextIdentity);
console.log("");
console.log("[oneshot] NEXT soul_md:");
console.log(nextSoul);
console.log("");

const identityChanged = (row.identity_md ?? "") !== nextIdentity;
const soulChanged = (row.soul_md ?? "") !== nextSoul;
console.log("[oneshot] changes:", {
  identity_md: identityChanged
    ? `${(row.identity_md ?? "").length} -> ${nextIdentity.length} chars`
    : "no change",
  soul_md: soulChanged ? `${(row.soul_md ?? "").length} -> ${nextSoul.length} chars` : "no change"
});

// The dashboard enforces these caps on save; a one-shot writing past them
// would produce a document the owner can no longer edit in the UI.
if (nextIdentity.length > BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS) {
  console.error(
    `[oneshot] identity_md is ${nextIdentity.length} chars, over the ${BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS} cap`
  );
  process.exit(1);
}
if (nextSoul.length > BUSINESS_CONFIG_SOUL_MD_MAX_CHARS) {
  console.error(
    `[oneshot] soul_md is ${nextSoul.length} chars, over the ${BUSINESS_CONFIG_SOUL_MD_MAX_CHARS} cap`
  );
  process.exit(1);
}

if (!identityChanged && !soulChanged) {
  console.log("[oneshot] already converged, nothing to write.");
  process.exit(0);
}

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

const { error: updateErr } = await db
  .from("business_configs")
  .update({
    identity_md: nextIdentity,
    soul_md: nextSoul,
    updated_at: new Date().toISOString()
  })
  .eq("business_id", BUSINESS_ID);

if (updateErr) {
  console.error("[oneshot] update failed:", updateErr.message);
  process.exit(1);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    identity_md_chars: nextIdentity.length,
    soul_md_chars: nextSoul.length,
    identity_changed: identityChanged,
    soul_changed: soulChanged,
    sections: ["vfm-brand:identity", "vfm-brand:soul"]
  }
});

console.log("[oneshot] applied. Syncing vault to the tenant box...");

// Push the new vault to the box now rather than waiting for the next owner
// edit: soul/identity are live text on every channel.
const { syncVaultToVps } = await import("../../src/lib/vps/sync-vault.ts");
const vault = await syncVaultToVps(BUSINESS_ID);
if (!vault.ok) {
  console.error(
    `[oneshot] vault sync failed (${vault.reason}${vault.detail ? `: ${vault.detail}` : ""}). ` +
      "The DB write landed; fix the VPS/SSH issue and re-run with --apply (idempotent)."
  );
  process.exit(1);
}
console.log(
  `[oneshot] vault sync ok (projectId=${vault.projectId}, instructionsLength=${vault.instructionsLength}).`
);
