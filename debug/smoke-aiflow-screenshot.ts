#!/usr/bin/env tsx
/**
 * One-shot CONTAINED smoke test for the AiFlow screenshot pipeline (no SMS,
 * no MMS, no email is sent — nothing touches a real lead or the owner):
 *
 *   1. Render service (on the tenant VPS, over localhost so the bearer never
 *      leaves the box): POST /render { url: example.com, screenshot: true }
 *      and assert the response carries a decodable JPEG screenshotBase64.
 *   2. Storage round-trip (service role): upload that JPEG to the new
 *      `aiflow-screenshots` bucket under smoke-test/, create a signed URL the
 *      way route_to_team does for MMS, download it back, compare bytes, then
 *      delete the object.
 *   3. ai-flow-worker liveness: POST without the cron bearer must 401 (proves
 *      the new deploy is up without executing any run).
 *
 * Usage (reads the repo-root `.env` automatically, like the rest of debug/):
 *   tsx debug/smoke-aiflow-screenshot.ts
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY,
 *      HOSTINGER_API_TOKEN. Optional: SMOKE_BUSINESS_ID.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";
import { getActiveVpsSshKeyForBusiness } from "../src/lib/db/vps-ssh-keys.ts";
import { sshExec } from "../src/lib/hostinger/ssh.ts";
import {
  ensureNextPublicSupabaseUrlOrExit,
  listTenantVpsTargets,
  requireServiceRoleAndHostingerToken,
  resolveTenantVpsPublicIp
} from "../scripts/lib/redeploy-tenant-vps.ts";

const BUSINESS_ID = process.env.SMOKE_BUSINESS_ID ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const BUCKET = "aiflow-screenshots";

// Runs on the VPS. The bearer is read from /opt/aiflow-render/.env in-place and
// only the JSON body (finalUrl/text lengths + base64) comes back.
const REMOTE_RENDER_SMOKE = `set -euo pipefail
TOKEN="$(grep '^AIFLOW_RENDER_TOKEN=' /opt/aiflow-render/.env | cut -d= -f2-)"
curl -sf --max-time 60 -X POST http://127.0.0.1:8080/render \\
  -H "Content-Type: application/json" \\
  \${TOKEN:+-H "Authorization: Bearer \${TOKEN}"} \\
  -d '{"url":"https://example.com/","screenshot":true}'
`;

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  loadEnv();
  ensureNextPublicSupabaseUrlOrExit();
  const hostingerToken = requireServiceRoleAndHostingerToken();

  // --- 1. render service screenshot over VPS localhost --------------------
  const targets = await listTenantVpsTargets(BUSINESS_ID);
  if (targets.length === 0) fail(`no VPS for business ${BUSINESS_ID}`);
  const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
  if (!key) fail("no active ssh key");
  const ip = await resolveTenantVpsPublicIp(targets[0].hostingerVpsId, hostingerToken, "[smoke]");
  if (!ip) fail("no public ip");

  const ssh = await sshExec({
    host: ip,
    port: 22,
    username: key.ssh_username,
    privateKeyPem: key.private_key_pem,
    command: REMOTE_RENDER_SMOKE,
    timeoutMs: 120_000
  });
  if (ssh.exitCode !== 0) fail(`render curl exit ${ssh.exitCode}: ${ssh.stderr.slice(-300)}`);
  const body = JSON.parse(ssh.stdout) as {
    finalUrl?: string;
    text?: string;
    html?: string;
    screenshotBase64?: string;
  };
  const b64 = body.screenshotBase64 ?? "";
  if (!b64) fail("render response has no screenshotBase64");
  const bytes = Buffer.from(b64, "base64");
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) fail("screenshot is not a JPEG (bad magic)");
  console.log(
    `1. render OK: finalUrl=${body.finalUrl} text=${(body.text ?? "").length}ch ` +
      `screenshot=${bytes.length} bytes (JPEG)`
  );

  // --- 2. storage round-trip: upload -> sign -> fetch -> delete -----------
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const path = `smoke-test/${Date.now()}.jpg`;
  const { error: upErr } = await db.storage
    .from(BUCKET)
    .upload(path, new Blob([bytes], { type: "image/jpeg" }), {
      contentType: "image/jpeg",
      upsert: true
    });
  if (upErr) fail(`bucket upload: ${upErr.message}`);
  const { data: signed, error: signErr } = await db.storage.from(BUCKET).createSignedUrl(path, 300);
  if (signErr || !signed?.signedUrl) fail(`sign: ${signErr?.message ?? "no url"}`);
  const fetched = await fetch(signed.signedUrl);
  if (!fetched.ok) fail(`signed URL fetch ${fetched.status}`);
  const roundTrip = Buffer.from(await fetched.arrayBuffer());
  if (!roundTrip.equals(bytes)) fail("signed-URL bytes differ from upload");
  const { error: rmErr } = await db.storage.from(BUCKET).remove([path]);
  if (rmErr) console.error(`(cleanup warning: ${rmErr.message})`);
  console.log(`2. bucket OK: ${bytes.length} bytes round-tripped via signed URL (object removed)`);

  // --- 3. worker liveness: unauthenticated POST must 401 ------------------
  const workerUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, "")}/functions/v1/ai-flow-worker`;
  const res = await fetch(workerUrl, { method: "POST" });
  if (res.status !== 401) fail(`worker expected 401 without cron auth, got ${res.status}`);
  console.log("3. worker OK: deployed function is live and rejects unauthenticated calls (401)");

  console.log("\nSMOKE PASS (no SMS/MMS/email sent)");
}

main().catch((err) => {
  console.error(`SMOKE FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
