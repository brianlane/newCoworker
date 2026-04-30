#!/usr/bin/env tsx
/**
 * Surgical one-shot to seed Rowboat's per-tenant project + api_key
 * directly on the brianlanefanmail VPS and patch
 * `business_configs.rowboat_project_id` in Supabase, so the dashboard
 * chat stops returning the "your coworker's chat service isn't ready"
 * 409 even though every container is healthy and the tunnel is wired.
 *
 * Why a focused script vs. re-running live-apply-bootstrap.ts:
 *   - live-apply-bootstrap.ts kicks off the full deploy-client.sh in
 *     the background (~25min, dominated by docker compose --build).
 *     We don't need that — every container on this host is already
 *     healthy from the previous deploy. The ONLY missing piece is
 *     the Rowboat MongoDB project document + api_keys row + the
 *     matching `business_configs.rowboat_project_id` row in
 *     Supabase. This script does just those three things in <30s.
 *
 * Idempotent: deleteMany then insertOne on both Mongo collections,
 * matched on `_id` / `projectId`. Re-running is safe — it just
 * re-stamps the same projectId / api key / workflow.
 *
 * Usage:
 *   set -a; source .env; set +a;
 *   npx tsx scripts/oneshot/seed-rowboat-and-fix-config.ts
 */
import { readFileSync } from "fs";
try {
  const env = readFileSync(`${process.cwd()}/.env`, "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* tolerable: assume env is exported in shell */
}

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sshExec } from "@/lib/hostinger/ssh";

const BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const PUBLIC_IP = "177.7.52.140";

async function ssh(privateKeyPem: string, command: string, label: string) {
  console.log(`\n[seed-rb] ${label}`);
  console.log(`         $ ${command.length > 200 ? `${command.slice(0, 197)}...` : command}`);
  const t0 = Date.now();
  const r = await sshExec({
    host: PUBLIC_IP,
    username: "root",
    privateKeyPem,
    command,
    timeoutMs: 2 * 60 * 1000
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`         -> exit=${r.exitCode} elapsed=${elapsed}s`);
  if (r.stdout) console.log(`         stdout: ${r.stdout.slice(-2000)}`);
  if (r.stderr) console.log(`         stderr: ${r.stderr.slice(-2000)}`);
  if (r.exitCode !== 0) {
    throw new Error(`[seed-rb] ${label} failed: exit=${r.exitCode}`);
  }
  return r;
}

async function main() {
  const db = await createSupabaseServiceClient();
  const { data: keys, error } = await db
    .from("vps_ssh_keys")
    .select("*")
    .eq("business_id", BUSINESS_ID)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`vps_ssh_keys lookup: ${error.message}`);
  if (!keys || keys.length === 0) throw new Error("no vps_ssh_keys row found");
  const key = keys[0];
  console.log(
    `[seed-rb] using key id=${key.id} hostinger_vps_id=${key.hostinger_vps_id} fp=${key.fingerprint_sha256}`
  );

  // Resolve runtime values from env / Supabase. We deliberately don't
  // re-read soul.md / identity.md / memory.md here because those are
  // already on the VPS in /opt/rowboat/vault from the prior deploy
  // and the workflow seed instruction set is intentionally minimal —
  // this script's purpose is to unblock chat, not to redo onboarding.
  const ROWBOAT_GATEWAY_TOKEN = process.env.ROWBOAT_GATEWAY_TOKEN;
  if (!ROWBOAT_GATEWAY_TOKEN) throw new Error("ROWBOAT_GATEWAY_TOKEN not set");
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  }

  const businessName = "AI Coworker";
  const now = new Date().toISOString();
  const workflow = {
    agents: [
      {
        name: "Coworker",
        type: "conversation",
        description: "Per-tenant AI coworker",
        disabled: false,
        instructions:
          "You are a professional AI coworker. Reply concisely and helpfully. " +
          "When the user asks operational questions, use the on-disk vault " +
          "(soul.md / identity.md / memory.md / website.md) to ground your " +
          "answers in the tenant's actual business context.",
        outputVisibility: "user_facing",
        controlType: "retain",
        model: "llama3.2:3b",
        ragK: 3,
        ragReturnType: "chunks"
      }
    ],
    prompts: [
      {
        name: "baseline",
        type: "base_prompt",
        prompt: `Owner-facing assistant for ${businessName}.`
      }
    ],
    tools: [],
    startAgent: "Coworker",
    lastUpdatedAt: now
  };

  // Build the mongosh seed script. Embed strings with JSON.stringify so
  // we never have to think about quote-escaping inside the heredoc.
  const seedJs = `
const projectId = ${JSON.stringify(BUSINESS_ID)};
const apiKey = ${JSON.stringify(ROWBOAT_GATEWAY_TOKEN)};
const workflow = ${JSON.stringify(workflow)};
const now = ${JSON.stringify(now)};
db.projects.deleteMany({ _id: projectId });
db.projects.insertOne({
  _id: projectId,
  name: ${JSON.stringify(businessName)},
  createdAt: now,
  createdByUserId: "newcoworker-orchestrator",
  secret: ${JSON.stringify(`deploy-${BUSINESS_ID}`)},
  draftWorkflow: workflow,
  liveWorkflow: workflow
});
db.api_keys.deleteMany({ projectId: projectId });
db.api_keys.insertOne({ projectId: projectId, key: apiKey, createdAt: now });
print(JSON.stringify({
  projects: db.projects.countDocuments({ _id: projectId }),
  keys: db.api_keys.countDocuments({ projectId: projectId })
}));
`;
  const seedB64 = Buffer.from(seedJs, "utf8").toString("base64");

  // Step 1: copy the seed script to the VPS, then into the mongo
  // container, then exec it.
  await ssh(
    key.private_key_pem,
    `printf '%s' '${seedB64}' | base64 -d > /tmp/rowboat-seed.js && wc -c /tmp/rowboat-seed.js`,
    "stage seed script on host"
  );
  await ssh(
    key.private_key_pem,
    `docker compose -f /opt/rowboat/docker-compose.yml cp /tmp/rowboat-seed.js mongo:/tmp/rowboat-seed.js`,
    "copy seed script into mongo container"
  );
  await ssh(
    key.private_key_pem,
    `docker compose -f /opt/rowboat/docker-compose.yml exec -T mongo mongosh --quiet rowboat /tmp/rowboat-seed.js`,
    "execute mongo seed script"
  );

  // Step 2: verify the docs landed.
  await ssh(
    key.private_key_pem,
    `docker compose -f /opt/rowboat/docker-compose.yml exec -T mongo mongosh --quiet --eval ` +
      `'JSON.stringify({ p: db.projects.find({_id:"${BUSINESS_ID}"}, {name:1}).toArray(), k: db.api_keys.find({projectId:"${BUSINESS_ID}"}, {createdAt:1}).toArray() })' rowboat`,
    "verify project + api_keys docs"
  );

  // Step 3: PATCH business_configs.rowboat_project_id directly via the
  // Supabase service-role key. We use the JS client (not curl) so the
  // failure mode is a typed error if RLS or schema changed under us.
  const { error: patchErr } = await db
    .from("business_configs")
    .update({ rowboat_project_id: BUSINESS_ID })
    .eq("business_id", BUSINESS_ID);
  if (patchErr) {
    throw new Error(`business_configs PATCH failed: ${patchErr.message}`);
  }
  console.log(
    `\n[seed-rb] business_configs.rowboat_project_id set to ${BUSINESS_ID}`
  );

  // Step 4: end-to-end probe — hit the same Rowboat URL the dashboard
  // chat will hit, with the same bearer token, against the project we
  // just seeded. Success = 200/400 (project exists; missing message
  // body is OK), 404 = the seed didn't take.
  await ssh(
    key.private_key_pem,
    `curl -sS -m 10 -o /dev/null -w 'rb-projects=%{http_code}\\n' ` +
      `-H "Authorization: Bearer ${ROWBOAT_GATEWAY_TOKEN}" ` +
      `http://127.0.0.1:3000/api/v1/${BUSINESS_ID}/chat -X POST ` +
      `-H "Content-Type: application/json" -d '{"messages":[]}'`,
    "probe Rowboat /api/v1/<projectId>/chat (expect 200/400, NOT 404)"
  );

  console.log(`\n[seed-rb] DONE.`);
}

main().catch((err) => {
  console.error("[seed-rb] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
