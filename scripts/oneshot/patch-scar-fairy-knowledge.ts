/**
 * patch-scar-fairy-knowledge.ts: build out Scar Fairy's business knowledge.
 *
 * Two writes to business_configs, both idempotent:
 *
 *   identity_md  Rewritten whole. Onboarding left 447 characters listing two
 *                devices and nothing else: no skin concerns, no packages, no
 *                prices. The coworker could not answer "do you treat melasma"
 *                or "what does the acne bundle cost". Now carries the concerns,
 *                the modalities, and the three bundle prices. identity is a
 *                knowledge-graph source at trust 3 (src/lib/memory/kg-sources.ts),
 *                the highest tier, so these facts outrank anything a lead claims.
 *
 *   soul_md      Repaired, not expanded. Its "Response Goals" section was
 *                compiled with four FAQ questions instead of goals, and its
 *                white-glove block still carried the placeholder greeting
 *                ("Hi name.  Thanks for contacting us."), a qualification
 *                question duplicated mid-sentence, and a handoff rule that
 *                contradicted the lead flow by forbidding any price quote.
 *
 * The content lives in scar-fairy-knowledge-content.ts (pure builders, pinned
 * by tests/oneshot-scar-fairy-definitions.test.ts). This script only reads,
 * shows the rollback, and writes.
 *
 * soul_md is live text on every channel and syncs to the tenant's box vault
 * (src/lib/vps/sync-vault.ts writes /opt/rowboat/vault/soul.md), so the
 * placeholder greeting is not dormant: it is what the account says today.
 *
 * memory_md is deliberately NOT touched. It already holds the FAQs, the
 * inquiry playbook, and the tone notes correctly.
 *
 * Usage (business id from --business or SCAR_FAIRY_BUSINESS_ID, never
 * hard-coded, per scripts/oneshot/README.md):
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-scar-fairy-knowledge.ts --business <uuid>          # dry-run
 *   npx tsx scripts/oneshot/patch-scar-fairy-knowledge.ts --business <uuid> --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";
import {
  buildScarFairyIdentityMd,
  buildScarFairySoulMd
} from "./scar-fairy-knowledge-content.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const businessArgIdx = process.argv.indexOf("--business");
const BUSINESS_ID =
  (businessArgIdx !== -1 ? process.argv[businessArgIdx + 1] : undefined) ??
  process.env.SCAR_FAIRY_BUSINESS_ID;
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set SCAR_FAIRY_BUSINESS_ID)");
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

const nextIdentity = buildScarFairyIdentityMd();
const nextSoul = buildScarFairySoulMd(row.soul_md ?? "");

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
  identity_md: identityChanged ? `${(row.identity_md ?? "").length} -> ${nextIdentity.length} chars` : "no change",
  soul_md: soulChanged ? `${(row.soul_md ?? "").length} -> ${nextSoul.length} chars` : "no change"
});

// The dashboard enforces these caps on save; a one-shot writing past them would
// produce a document the owner can no longer edit in the UI.
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
    repaired: ["response_goals_section", "white_glove_block", "price_quote_contradiction"]
  }
});

console.log("[oneshot] applied.");
console.log(
  "[oneshot] NOTE: soul.md and identity.md ship to the box on the next vault sync."
);
