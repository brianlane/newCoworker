#!/usr/bin/env tsx
/**
 * One-shot: move a tenant's Google Workspace connection from Nango-brokered to
 * first-party, WITHOUT the owner touching anything.
 *
 * Nango's `google` integration is configured with OUR verified OAuth client
 * (`354099628168-...`, proved by `debug/google-nango-export-audit.ts` on
 * 2026-08-11), so the refresh token it holds is ours to redeem. That is what
 * makes a silent migration possible at all: the alternative is asking each owner
 * to re-consent, and for KYP Ads that is a support conversation about a change
 * they did not ask for.
 *
 * Per connection:
 *
 *   1. Export the refresh token from Nango.
 *   2. REDEEM IT AGAINST OUR OWN TOKEN ENDPOINT FIRST. Nothing is written until
 *      Google has actually answered with a working access token. A row flipped
 *      to `direct` around a token that turns out to be unusable is a mailbox
 *      that stops working with no owner-visible cause, which is strictly worse
 *      than staying on Nango.
 *   3. Flip the EXISTING row in place, same row id, so every AiFlow
 *      `send_email` binding, email trigger and shared-calendar id survives.
 *   4. Leave the Nango connection ALIVE, and record its id in metadata, so this
 *      is a two-way door.
 *
 * ## Rollback
 *
 * `metadata.migrated_from_nango_connection_id` holds the Nango connection id the
 * row used to point at. To roll back: set `transport` to 'nango', restore
 * `connection_id` from that key, and null the three token columns. The Nango
 * grant is still there, untouched, so the mailbox resumes working immediately.
 * Without that metadata key rollback would be impossible, because the flip
 * overwrites `connection_id` with a synthetic `direct:<uuid>`.
 *
 * ## Finishing the job (NOT done here, deliberately)
 *
 * After the flip, the Nango connection has no DB row pointing at it, so
 * `debug/nango-audit.ts` reports it as a Nango-side orphan. That is correct and
 * intentional: it is the rollback path, kept on purpose. Once the direct
 * connection is verified working, deleting that grant with
 * `tsx debug/nango-audit.ts --apply` is the last step, and it reclaims the
 * account-wide Nango seat. Do NOT run that until you are done rolling back.
 *
 * Dry-run by default. Pass --apply to write. `--business-id <uuid>` restricts to
 * one tenant, which is how this should be run: internal sandbox first, then New
 * Coworker HQ and verify it end to end, and only then the real customer.
 *
 * ## What the 2026-08-12 dry run found, which changes the running order
 *
 * All three connections redeemed successfully against our client, so a silent
 * import works for every one of them. But the GRANTED scopes differ, and two of
 * them are worth knowing before applying:
 *
 *  - **New Coworker HQ** (`8f3a5c21`, `newcoworkerteam@gmail.com`) holds all
 *    seven scopes, carries a `shared_calendar_id` in metadata, and is bound by
 *    TWO enabled flows ("Google review demo reply (HQ)", "Team inbox triage
 *    (HQ)"). It is therefore the real test of this script: if the row id or the
 *    metadata did not survive, those two flows would start failing at send time.
 *    Verify HQ end to end before touching the customer.
 *
 *  - **KYP Ads** (`056034a7`, the only real customer) holds a CALENDAR-ONLY
 *    grant: `calendar.events`, `openid`, `userinfo.*`, and NO `gmail.modify`.
 *    It is also bound by no flows at all, so nothing is broken today, but it
 *    means this row cannot serve mail and never could. Importing it preserves
 *    that faithfully, which is correct: `oauth_scope` records what the owner
 *    actually granted, and capability gating reads that rather than assuming.
 *    If KYP ever wants email, they need a fresh consent, not a token import.
 *    Their row is also UNLABELED (`end_user_email` only, no
 *    `provider_account_email`), which is why the dashboard reconnect path would
 *    take the identity-probe branch for them.
 *
 *  - **The internal Google Review Sandbox** (`e2b7a1c4`) still holds
 *    `gmail.settings.basic`. That scope was removed from the request during the
 *    Jul 2026 verification restart, and `google-oauth-assets/verification-reply.md`
 *    told Google it "was REMOVED rather than justified". The grant predates the
 *    freeze (created Jul 16, frozen Jul 26), and an existing grant keeps whatever
 *    it was issued with. Nothing requests it now, but a live token can still
 *    call Gmail settings endpoints. Re-consenting that connection through the
 *    dashboard button drops it, which is the cleanest fix and worth doing on the
 *    sandbox regardless, since it doubles as the OAuth client's inactivity reset.
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { loadEnv } from "../../debug/_shared.ts";
import { createClient } from "@supabase/supabase-js";
import { getNangoClient } from "../../src/lib/nango/server.ts";
import { refreshGoogleTokens } from "../../src/lib/google/oauth.ts";
import { recordOneshotApplied } from "./_ledger.ts";

loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) throw new Error("Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
if (!process.env.NANGO_SECRET_KEY) throw new Error("Missing NANGO_SECRET_KEY");
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (needed to redeem the token)");
}
if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) {
  // Without it the token columns would be written under a different envelope
  // key than production reads with, so the mailbox would break on first use.
  throw new Error("Missing INTEGRATIONS_ENCRYPTION_KEY (needed to encrypt at rest)");
}

const db = createClient(url, key, { auth: { persistSession: false } });
const APPLY = process.argv.includes("--apply");
const onlyBusinessId = (() => {
  const i = process.argv.indexOf("--business-id");
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
})();

/** Nango provider config keys that broker Google. */
const GOOGLE_PROVIDER_KEYS = ["google", "google-mail", "gmail", "google-calendar"];
const ROW_CEILING = 1000;

type Row = {
  id: string;
  business_id: string;
  provider_config_key: string;
  connection_id: string;
  metadata: Record<string, unknown> | null;
  transport: string;
};

/** Presence + last 4 + sha256 prefix. Never the value. */
function fingerprint(secret: string | null | undefined): string {
  if (typeof secret !== "string" || secret.length === 0) return "absent";
  return `len=${secret.length} …${secret.slice(-4)} sha256=${createHash("sha256").update(secret).digest("hex").slice(0, 12)}`;
}

async function main() {
  const nango = getNangoClient();
  const { encryptIntegrationSecret } = await import("../../src/lib/integrations/secrets.ts");

  let query = db
    .from("workspace_oauth_connections")
    .select("id, business_id, provider_config_key, connection_id, metadata, transport", {
      count: "exact"
    })
    .in("provider_config_key", GOOGLE_PROVIDER_KEYS)
    .eq("transport", "nango")
    .order("created_at", { ascending: true })
    .limit(ROW_CEILING);
  if (onlyBusinessId) query = query.eq("business_id", onlyBusinessId);

  const { data, error, count } = await query;
  if (error) throw new Error(`list rows: ${error.message}`);
  const rows = (data ?? []) as Row[];

  // A truncated read cannot support a fleet-wide claim. Refuse rather than
  // report a partial migration as complete.
  if (typeof count === "number" && count > rows.length) {
    throw new Error(
      `Read ${rows.length} of ${count} matching rows; the ${ROW_CEILING} ceiling truncated the result. Page through before trusting this run.`
    );
  }

  console.log(
    `${rows.length} Nango-brokered Google connection(s)${onlyBusinessId ? ` for ${onlyBusinessId}` : " (whole fleet)"}; ${APPLY ? "APPLY" : "dry-run"}\n`
  );
  if (rows.length === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  let migrated = 0;
  let skipped = 0;

  for (const row of rows) {
    const md = row.metadata ?? {};
    const account =
      (typeof md.provider_account_email === "string" && md.provider_account_email) || "(unlabeled)";
    const label = `${row.provider_config_key} …${row.connection_id.slice(-6)} (${account}, business ${row.business_id.slice(0, 8)})`;
    console.log(`- ${label}`);

    // 1. Export the refresh token Nango holds.
    let refreshToken: string | null = null;
    try {
      const conn = (await nango.getConnection(
        row.provider_config_key,
        row.connection_id,
        false,
        true
      )) as { credentials?: { refresh_token?: string | null } };
      refreshToken = conn?.credentials?.refresh_token ?? null;
    } catch (err) {
      skipped += 1;
      console.log(`    SKIP: could not read the Nango connection: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (!refreshToken) {
      skipped += 1;
      console.log("    SKIP: Nango returned no refresh token, so there is nothing to import.");
      console.log("          This owner needs a guided reconnect through the dashboard button instead.");
      continue;
    }
    console.log(`    refresh token  ${fingerprint(refreshToken)}`);

    // 2. Prove it works against OUR client BEFORE writing anything.
    let tokens;
    try {
      tokens = await refreshGoogleTokens(refreshToken);
    } catch (err) {
      skipped += 1;
      console.log(`    SKIP: Google refused the token for our client: ${err instanceof Error ? err.message : err}`);
      console.log("          Nothing written. The row stays on Nango and keeps working.");
      continue;
    }
    console.log(`    redeemed ok    access ${fingerprint(tokens.accessToken)}`);
    console.log(`    granted scope  ${tokens.grantedScope ?? "(not reported)"}`);

    if (!APPLY) {
      migrated += 1;
      console.log("    would flip this row to transport=direct (dry-run)");
      continue;
    }

    // 3. Flip the row in place. Same id, so every binding survives.
    const newConnectionId = `direct:${randomUUID()}`;
    const { error: flipError } = await db
      .from("workspace_oauth_connections")
      .update({
        connection_id: newConnectionId,
        transport: "direct",
        is_active: true,
        access_token_encrypted: encryptIntegrationSecret(tokens.accessToken),
        refresh_token_encrypted: encryptIntegrationSecret(refreshToken),
        token_expires_at: tokens.expiresAt.toISOString(),
        // Whatever Google reported, never the set we asked for: the owner may
        // have unticked a box, and this column is what capability gating reads.
        ...(tokens.grantedScope ? { oauth_scope: tokens.grantedScope } : {}),
        metadata: {
          ...md,
          connected_via: "google_oauth_import",
          // The ONLY record of what to restore on rollback: the flip overwrites
          // connection_id, so without this the Nango grant cannot be re-pointed.
          migrated_from_nango_connection_id: row.connection_id,
          migrated_from_provider_config_key: row.provider_config_key,
          migrated_at: new Date().toISOString()
        },
        updated_at: new Date().toISOString()
      })
      .eq("id", row.id)
      .eq("business_id", row.business_id);

    if (flipError) {
      skipped += 1;
      console.log(`    FAILED to write: ${flipError.message}`);
      continue;
    }
    migrated += 1;
    console.log(`    migrated. row id ${row.id} unchanged; Nango grant left alive for rollback`);
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1],
      businessId: row.business_id,
      details: {
        connectionRowId: row.id,
        fromProviderConfigKey: row.provider_config_key,
        fromNangoConnectionId: row.connection_id,
        toConnectionId: newConnectionId,
        grantedScope: tokens.grantedScope
      }
    });
  }

  console.log(
    `\n${APPLY ? "migrated" : "would migrate"} ${migrated}, skipped ${skipped}${APPLY ? "" : " (dry-run, nothing written)"}`
  );
  if (APPLY && migrated > 0) {
    console.log("\nNEXT, in order:");
    console.log("  1. Verify the tenant end to end: send an email, book and reschedule, load the booking page.");
    console.log("  2. Only once verified, reclaim the Nango seat: tsx debug/nango-audit.ts --apply");
    console.log("     That deletes the orphaned Nango grant AND removes the rollback path, so do not");
    console.log("     run it while you might still want to roll back.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
