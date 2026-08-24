/**
 * mint-kin-zapier-key.ts: mint the KIN Integrated Child Health API key that
 * James's Zapier bridge authenticates with.
 *
 * KIN's Meta leads arrive the same way KYP's and Scar Fairy's do: James runs
 * the ads, a Zap ("Send Lead to Coworker", the `send_lead` action of the
 * NewCoworker Zapier app) relays each Facebook lead to
 * POST /api/public/v1/flow-events, and the webhook trigger starts the lead
 * follow-up flow. No meta_connections row, bridge-only, purely off lead
 * source. The Zapier app authenticates with a per-tenant API key, normally
 * minted on /dashboard/integrations; this script mints it operator-side so
 * the credential can be handed to James without waiting on the owner.
 *
 * Same generation code as the dashboard route (mintApiKey + insertApiKey):
 * the plaintext is printed ONCE and never stored; the DB keeps the SHA-256.
 *
 * Idempotent: refuses to mint when an active key with the same name already
 * exists (prints its prefix instead). --rotate revokes same-name keys first.
 *
 * Usage:
 *   npx tsx scripts/oneshot/mint-kin-zapier-key.ts --business <uuid>            # dry-run
 *   npx tsx scripts/oneshot/mint-kin-zapier-key.ts --business <uuid> --apply
 *   npx tsx scripts/oneshot/mint-kin-zapier-key.ts --business <uuid> --apply --rotate
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const ROTATE = process.argv.includes("--rotate");
const businessArgIdx = process.argv.indexOf("--business");
const BUSINESS_ID =
  (businessArgIdx !== -1 ? process.argv[businessArgIdx + 1] : undefined) ??
  process.env.KIN_BUSINESS_ID;
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set KIN_BUSINESS_ID)");
  process.exit(1);
}
const KEY_NAME = "Zapier (Meta leads via KYP)";

const { mintApiKey } = await import("../../src/lib/public-api/keys.ts");
const { insertApiKey, listApiKeys, revokeApiKey } = await import("../../src/lib/db/api-keys.ts");
const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const existing = await listApiKeys(BUSINESS_ID, db as never);
const sameName = existing.filter((k) => k.name === KEY_NAME && !k.revoked_at);
console.log(`[oneshot] business ${BUSINESS_ID}: ${existing.length} key(s), ${sameName.length} active named "${KEY_NAME}"`);
for (const k of sameName) console.log(`  active: ${k.key_prefix}... created ${k.created_at}`);

if (sameName.length > 0 && !ROTATE) {
  console.log("[oneshot] already minted; nothing to do (use --rotate to replace).");
  process.exit(0);
}
if (!APPLY) {
  console.log(`[oneshot] dry-run: would mint a key named "${KEY_NAME}"${ROTATE && sameName.length ? " and revoke the old one(s)" : ""}. Re-run with --apply.`);
  process.exit(0);
}

const minted = mintApiKey();
const row = await insertApiKey(
  { businessId: BUSINESS_ID, name: KEY_NAME, keyPrefix: minted.prefix, keyHash: minted.hash },
  db as never
);
if (ROTATE) {
  for (const k of sameName) {
    await revokeApiKey(BUSINESS_ID, k.id, db as never);
    console.log(`[oneshot] revoked old key ${k.key_prefix}...`);
  }
}
await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: { keyId: row.id, keyPrefix: minted.prefix, rotated: ROTATE ? sameName.length : 0 }
});
console.log("[oneshot] minted. Hand this to James for the Zap's auth; it is shown ONCE and not stored:");
console.log(`\n  ${minted.plaintext}\n`);
console.log("[oneshot] revoke or rotate any time from /dashboard/integrations or by re-running with --rotate.");
