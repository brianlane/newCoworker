#!/usr/bin/env tsx
/**
 * Phase-0 gate for moving Google Workspace OAuth off Nango onto our own client.
 *
 * READ ONLY. There is no --apply, and there never should be: this script
 * decides the SHAPE of the migration, it does not perform any of it.
 *
 * Two questions, in order of how much they matter:
 *
 *   1. WHOSE OAuth client does Nango hold for the `google*` integrations?
 *      Verification and ADA-CASA AL1 attached to OUR client (GCP project
 *      `new-coworker`, project number 354099628168) because it requests
 *      `gmail.modify`. Nango only brokers the flow. If Nango is configured
 *      with our client, an exported refresh token can be redeemed against
 *      our own token endpoint and the migration is a silent backfill that no
 *      owner ever sees. If Nango holds ITS OWN client instead, that path is
 *      dead (the token is not ours to redeem) AND it means live production
 *      Google grants sit on an unverified client, which is a compliance
 *      finding in its own right. Stop and escalate in that case.
 *
 *   2. Does Nango actually return the refresh token, per connection?
 *      `getConnection(key, id, forceRefresh, refreshToken)` maps its 4th
 *      argument to `?refresh_token=true`. Presence is per-connection, not a
 *      plan-wide guarantee, so ask each one rather than generalizing.
 *
 * It also prints the integration's configured `scopes`, which is the
 * AUTHORITATIVE scope set the consent screen was verified against. Copy the
 * frozen set from here (cross-checked against the Cloud Console), never from
 * memory: adding a scope outside the approved set requires a fresh
 * verification request, and verification cannot be inherited. See
 * google-oauth-assets/casa/recert-runbook.md.
 *
 * Secret hygiene: client ids are not secrets (ours is readable in the
 * consent-screen URL of the submitted demo video) so they print in full for
 * eyeballing. Client secrets and refresh tokens are NEVER printed, not even
 * truncated: only presence, a last-4, and a sha256 prefix, which is enough
 * to tell two tokens apart across runs without disclosing either.
 */
import { createHash } from "node:crypto";
import { loadEnv } from "./_shared.ts";
import { createClient } from "@supabase/supabase-js";
import { getNangoClient } from "../src/lib/nango/server.ts";

loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) throw new Error("Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
if (!process.env.NANGO_SECRET_KEY) throw new Error("Missing NANGO_SECRET_KEY");

const db = createClient(url, key, { auth: { persistSession: false } });

/**
 * GCP project number for `new-coworker`, per
 * google-oauth-assets/casa/recert-runbook.md. Every OAuth client id in that
 * project is prefixed with it, so this is the check that answers question 1.
 * The full client id is deliberately NOT hardcoded: the repo only records it
 * truncated, and a wrong literal here would report a false mismatch on the
 * one question this script exists to answer.
 */
const OUR_GCP_PROJECT_NUMBER = "354099628168";

/** Nango provider config keys that broker Google, per src/lib/nango/account-identity.ts. */
const GOOGLE_PROVIDER_KEYS = ["google", "google-mail", "gmail", "google-calendar"];

/**
 * Row ceiling for the Google query.
 *
 * PostgREST caps un-limited selects at 1000 rows and truncates SILENTLY, so an
 * unbounded read cannot tell "that is all of them" from "that is the first
 * page". This script's verdict is a fleet-wide claim, so a truncated read must
 * refuse to answer rather than answer from a sample. The filter runs in Postgres
 * (not in memory) so the ceiling applies to Google rows only, and hitting it is
 * treated as a hard stop below.
 */
const ROW_CEILING = 1000;

type DbRow = {
  business_id: string;
  provider_config_key: string;
  connection_id: string;
  metadata: Record<string, unknown> | null;
};

/** Presence + last-4 + sha256 prefix. Never the value. */
function fingerprint(secret: string | null | undefined): string {
  if (typeof secret !== "string" || secret.length === 0) return "absent";
  const digest = createHash("sha256").update(secret).digest("hex").slice(0, 12);
  return `present len=${secret.length} …${secret.slice(-4)} sha256=${digest}`;
}

function accountEmailOf(row: DbRow): string {
  const md = row.metadata ?? {};
  const email = md.provider_account_email ?? md.end_user_email;
  return typeof email === "string" && email ? email : "(unknown)";
}

async function main() {
  const nango = getNangoClient();

  // Filter server-side: the row ceiling must bound GOOGLE rows, not all
  // workspace rows, or a fleet with >1000 Outlook connections would push Google
  // rows out of the window and this audit would never see them. Ordered so the
  // window is deterministic rather than whatever Postgres returns first.
  const { data, error, count } = await db
    .from("workspace_oauth_connections")
    .select("business_id, provider_config_key, connection_id, metadata", { count: "exact" })
    .in("provider_config_key", GOOGLE_PROVIDER_KEYS)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(ROW_CEILING);
  if (error) throw new Error(`list DB rows: ${error.message}`);
  const googleRows = (data ?? []) as DbRow[];

  // A truncated read cannot support a fleet-wide verdict. Refuse rather than
  // declare Path A open over a sample: an unaudited live grant is exactly the
  // thing that would break the migration silently.
  //
  // The exact count is the authority, so completeness is `count === rows read`,
  // NOT `rows read < ceiling`. Those differ at exactly ROW_CEILING matching
  // rows, where the read is complete but a length-based test would false-stop.
  // The ceiling comparison is only the fallback for when PostgREST gives us no
  // count, where a full page is indistinguishable from a truncated one.
  const exactTotal = typeof count === "number" ? count : null;
  const truncated =
    exactTotal === null ? googleRows.length >= ROW_CEILING : exactTotal > googleRows.length;
  if (truncated) {
    console.error(
      `STOP. Read ${googleRows.length} Google row(s), table holds ` +
        `${exactTotal === null ? "an unreported number" : exactTotal}. The row ceiling ` +
        `(${ROW_CEILING}) truncated the result, so this audit cannot speak for the whole ` +
        `fleet. Page through the remainder before trusting any verdict.`
    );
    process.exitCode = 2;
    return;
  }

  const totalLabel = exactTotal === null ? "count unreported" : `of ${exactTotal} total, complete`;
  console.log(`Google-brokered rows in workspace_oauth_connections: ${googleRows.length} (${totalLabel})\n`);
  if (googleRows.length === 0) {
    console.log("Nothing to migrate. (Non-Google rows are out of scope for this audit.)");
    return;
  }

  // ── Question 1: whose client, and which scopes ────────────────────────────
  const keysInUse = [...new Set(googleRows.map((r) => r.provider_config_key))].sort();
  console.log("── Integration credentials (question 1: whose OAuth client?) ──");
  let allOurs = true;
  let anyChecked = false;
  for (const uniqueKey of keysInUse) {
    let integration;
    try {
      integration = await nango.getIntegration({ uniqueKey }, { include: ["credentials"] });
    } catch (err) {
      allOurs = false;
      console.log(`  ${uniqueKey}: FETCH FAILED: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const creds = integration?.data?.credentials as
      | { client_id?: string | null; client_secret?: string | null; scopes?: string | null }
      | undefined;
    const clientId = creds?.client_id ?? null;
    if (!clientId) {
      allOurs = false;
      console.log(`  ${uniqueKey}: no client_id returned, cannot confirm ownership`);
      continue;
    }
    anyChecked = true;
    const ours = clientId.startsWith(`${OUR_GCP_PROJECT_NUMBER}-`);
    if (!ours) allOurs = false;
    console.log(`  ${uniqueKey}:`);
    console.log(`    client_id     ${clientId}`);
    console.log(`    verdict       ${ours ? `OURS (project ${OUR_GCP_PROJECT_NUMBER})` : "*** NOT OUR CLIENT ***"}`);
    console.log(`    client_secret ${fingerprint(creds?.client_secret)}`);
    const scopes = (creds?.scopes ?? "").split(/[\s,]+/).filter(Boolean);
    console.log(`    scopes (${scopes.length}) ${scopes.length ? "" : "(none configured)"}`);
    for (const scope of scopes) console.log(`      - ${scope}`);
  }

  // ── Question 2: is the refresh token exportable, per connection ───────────
  //
  // Three outcomes, counted separately and never collapsed. "We asked and there
  // is no refresh token" (needs re-consent) and "we could not ask" (an API error)
  // are different facts, and reporting the second as the first would recommend a
  // re-consent campaign on no evidence.
  console.log("\n── Per-connection refresh token (question 2: exportable?) ──");
  let exportable = 0;
  let missing = 0;
  let unknown = 0;
  for (const row of googleRows) {
    const label = `${row.provider_config_key} …${row.connection_id.slice(-6)} (${accountEmailOf(row)}, business ${row.business_id.slice(0, 8)})`;
    let connection;
    try {
      // (providerConfigKey, connectionId, forceRefresh, refreshToken)
      connection = await nango.getConnection(row.provider_config_key, row.connection_id, false, true);
    } catch (err) {
      unknown += 1;
      console.log(`  ${label}\n    FETCH FAILED: ${err instanceof Error ? err.message : err}`);
      console.log(`    NOT AUDITED, this row's token status is unknown, not absent`);
      continue;
    }
    const creds = connection?.credentials as
      | { refresh_token?: string | null; access_token?: string | null; scope?: string | null; type?: string }
      | undefined;
    const refresh = creds?.refresh_token;
    if (typeof refresh === "string" && refresh.length > 0) exportable += 1;
    else missing += 1;
    console.log(`  ${label}`);
    console.log(`    type          ${creds?.type ?? "(unknown)"}`);
    console.log(`    refresh_token ${fingerprint(refresh)}`);
    console.log(`    access_token  ${fingerprint(creds?.access_token)}`);
    console.log(`    granted scope ${creds?.scope ?? "(not reported)"}`);
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  console.log("\n── Verdict ──");
  if (!anyChecked || !allOurs) {
    console.log("STOP. At least one google* integration is not confirmed on our client.");
    console.log("Do not start the migration. Live Google grants may sit on an unverified");
    console.log("client, which is a compliance finding, and exported tokens would not be");
    console.log("ours to redeem. Escalate before writing any code.");
    process.exitCode = 2;
    return;
  }
  const rowIdNote =
    "Either path must preserve the workspace_oauth_connections row id: AiFlow " +
    "send_email steps bind it as fromConnectionId, and the row's metadata carries " +
    "shared_calendar_id.";

  // An unaudited row is not a row without a token. Refuse to recommend anything
  // while any row's status is unknown, or a transient Nango outage would read as
  // "these owners must re-consent".
  if (unknown > 0) {
    console.error(
      `INCONCLUSIVE. ${unknown} of ${googleRows.length} connection(s) could not be fetched, ` +
        `so their token status is unknown, NOT absent. Counted: ${exportable} exportable, ` +
        `${missing} genuinely missing a refresh token, ${unknown} unaudited. Re-run once ` +
        `Nango is reachable before choosing a migration path.`
    );
    process.exitCode = 2;
    return;
  }
  if (exportable === googleRows.length) {
    console.log(`Path A (silent token import) is open: ${exportable}/${googleRows.length} connections`);
    console.log("returned a refresh token, all on our client. No owner has to re-consent.");
    console.log(rowIdNote);
    return;
  }
  console.log(`Path A is open for ${exportable}/${googleRows.length} connection(s).`);
  console.log(`${missing} connection(s) returned no refresh token and need Path B (guided re-consent).`);
  console.log(rowIdNote);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
