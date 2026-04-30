#!/usr/bin/env tsx
/**
 * End-to-end smoke for brianlanefanmail's VPS (id 1632631 / 177.7.52.140).
 * Run after seed-rowboat-and-fix-config.ts to confirm every layer is
 * actually wired:
 *   - cloudflared tunnel running + healthy
 *   - Rowboat container responding on loopback :3000
 *   - Rowboat /api/v1/<projectId>/chat exists (i.e. project seed took)
 *   - voice-bridge container running
 *   - Ollama responding
 *   - tunnel CNAME resolves to *.cfargotunnel.com
 *   - external https://<biz>.tunnel.newcoworker.com handshake
 *     (KNOWN gap: alert 40 until Total TLS is enabled on the zone)
 *   - Supabase business_configs.rowboat_project_id matches BUSINESS_ID
 *   - Supabase businesses.status == 'online'
 *
 * Usage:
 *   set -a; source .env; set +a;
 *   npx tsx scripts/oneshot/smoke-brianlanefanmail.ts
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
  /* tolerable */
}

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sshExec } from "@/lib/hostinger/ssh";

const BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const PUBLIC_IP = "177.7.52.140";
const HOSTNAME = `${BUSINESS_ID}.tunnel.newcoworker.com`;

type CheckResult = { name: string; pass: boolean; detail: string };
const results: CheckResult[] = [];

async function ssh(privateKeyPem: string, command: string) {
  const r = await sshExec({
    host: PUBLIC_IP,
    username: "root",
    privateKeyPem,
    command,
    timeoutMs: 30 * 1000
  });
  return r;
}

async function main() {
  const db = await createSupabaseServiceClient();
  const { data: keys } = await db
    .from("vps_ssh_keys")
    .select("*")
    .eq("business_id", BUSINESS_ID)
    .order("created_at", { ascending: false })
    .limit(1);
  if (!keys || keys.length === 0) throw new Error("no vps_ssh_keys row");
  const key = keys[0];

  // 1. Cloudflared tunnel
  const cfd = await ssh(
    key.private_key_pem,
    `systemctl is-active cloudflared 2>/dev/null || echo inactive`
  );
  results.push({
    name: "cloudflared service",
    pass: cfd.stdout.trim() === "active",
    detail: cfd.stdout.trim()
  });

  // 2. Rowboat loopback HTTP
  const rb = await ssh(
    key.private_key_pem,
    `curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/`
  );
  results.push({
    name: "Rowboat loopback /",
    pass: ["200", "302", "307"].includes(rb.stdout.trim()),
    detail: `HTTP ${rb.stdout.trim()}`
  });

  // 3. Rowboat per-project chat (seeded? expect 200/400 not 404)
  const ROWBOAT_GATEWAY_TOKEN = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  const rbProj = await ssh(
    key.private_key_pem,
    `curl -sS -m 10 -o /dev/null -w '%{http_code}' ` +
      `-H "Authorization: Bearer ${ROWBOAT_GATEWAY_TOKEN}" ` +
      `-H "Content-Type: application/json" ` +
      `-d '{"messages":[]}' ` +
      `-X POST http://127.0.0.1:3000/api/v1/${BUSINESS_ID}/chat`
  );
  const rbProjCode = rbProj.stdout.trim();
  results.push({
    name: "Rowboat project chat (loopback)",
    pass: rbProjCode === "200" || rbProjCode === "400",
    detail: `HTTP ${rbProjCode} (200/400=ok, 404=project missing)`
  });

  // 4. Voice-bridge container
  const vb = await ssh(
    key.private_key_pem,
    `docker ps --filter name=voice-bridge --format '{{.Status}}' | head -1`
  );
  results.push({
    name: "voice-bridge container",
    pass: vb.stdout.trim().startsWith("Up"),
    detail: vb.stdout.trim() || "<missing>"
  });

  // 5. Ollama
  const ol = await ssh(
    key.private_key_pem,
    `curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:11434/api/tags`
  );
  results.push({
    name: "Ollama /api/tags",
    pass: ol.stdout.trim() === "200",
    detail: `HTTP ${ol.stdout.trim()}`
  });

  // 6. Public DNS resolution for tunnel hostname.
  //    `dig` is in `dnsutils` which we don't install on minimal hosts;
  //    `getent hosts` ships with glibc on every Ubuntu image and works
  //    against the OS resolver chain (collapses CNAME→A so we get an
  //    IPv4, but Cloudflare-edge IPv4s start with 104./172. which is
  //    a stable test for "CNAME pointed at the tunnel").
  const dns = await ssh(
    key.private_key_pem,
    `getent hosts ${HOSTNAME} | awk '{print $1}' | head -1`
  );
  const dnsIp = dns.stdout.trim();
  // CF edge ranges (IPv4 + IPv6). Both 104.* / 172.64-71.* (v4) and
  // 2606:4700::/32 (v6) are Cloudflare-published. `getent hosts`
  // returns whichever AAAA/A came first; either is fine for the
  // "CNAME landed at the tunnel" sanity check.
  const isCfEdge =
    /^(104\.|172\.6[4-9]\.|172\.7[01]\.)/.test(dnsIp) ||
    /^2606:4700:/.test(dnsIp);
  results.push({
    name: "tunnel hostname → CF edge",
    pass: isCfEdge,
    detail: dnsIp || "<no record>"
  });

  // 7. External TLS handshake (expected fail until Total TLS is on)
  const tls = await ssh(
    key.private_key_pem,
    `curl -sS -m 10 -o /dev/null -w '%{http_code}' --connect-timeout 5 https://${HOSTNAME}/api/health || echo TLS-FAIL`
  );
  const tlsOk = tls.stdout.trim() === "200" || tls.stdout.trim() === "404";
  results.push({
    name: "external https handshake",
    pass: tlsOk,
    detail: tlsOk
      ? `HTTP ${tls.stdout.trim()}`
      : `${tls.stdout.trim()} (expected fail until Cloudflare Total TLS is ENABLED on zone newcoworker.com)`
  });

  // 8. Supabase business_configs.rowboat_project_id
  const { data: cfg } = await db
    .from("business_configs")
    .select("rowboat_project_id")
    .eq("business_id", BUSINESS_ID)
    .maybeSingle();
  results.push({
    name: "business_configs.rowboat_project_id",
    pass: cfg?.rowboat_project_id === BUSINESS_ID,
    detail: cfg?.rowboat_project_id ?? "<empty>"
  });

  // 9. Supabase businesses.status (schema: status / hostinger_vps_id;
  //    no `vps_ip` column — that's `hostinger_vps_id` mapped through
  //    the Hostinger API for IPv4).
  const { data: biz } = await db
    .from("businesses")
    .select("status,hostinger_vps_id")
    .eq("id", BUSINESS_ID)
    .maybeSingle();
  results.push({
    name: "businesses.status",
    pass: biz?.status === "online",
    detail: `${biz?.status} (hostinger_vps_id=${biz?.hostinger_vps_id})`
  });

  // Summary
  console.log("\n=== smoke results ===");
  for (const r of results) {
    const icon = r.pass ? "PASS" : "FAIL";
    console.log(`[${icon}] ${r.name.padEnd(38)} ${r.detail}`);
  }
  const failed = results.filter((r) => !r.pass);
  if (failed.length === 0) {
    console.log("\nALL GREEN — VPS is fully operational.");
  } else {
    console.log(`\n${failed.length} check(s) need attention.`);
  }
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
