#!/usr/bin/env tsx
/**
 * One-shot CLI: delegate `<TUNNEL_LABEL>.<ROOT_DOMAIN>` to its own
 * Cloudflare zone so the multi-level tunnel hostnames (e.g.
 * `<businessId>.tunnel.newcoworker.com`) collapse to a single wildcard
 * level under a NEW zone — and therefore get covered by free Universal
 * SSL. See `src/lib/cloudflare/subzone.ts` for the full rationale.
 *
 * PII-free by design: every business-specific value comes from env or
 * argv — the script itself never names a tenant. This is the pattern
 * future one-shots should follow per `scripts/oneshot/README.md`.
 *
 * Usage:
 *   set -a; source .env; set +a;
 *   npx tsx scripts/oneshot/ensure-tunnel-subzone.ts [tunnel-label] [root-domain]
 *
 * Env required:
 *   CLOUDFLARE_API_TOKEN     — must include
 *                              `Account: Zone:Edit` (zone create) +
 *                              `Zone: DNS:Edit` on the parent zone.
 *   CLOUDFLARE_ACCOUNT_ID    — account that owns the parent zone.
 *   CLOUDFLARE_ZONE_ID       — id of the parent zone (the one you
 *                              currently CNAME tunnel hostnames into).
 *
 * Optional argv:
 *   argv[2] — tunnel label (defaults to "tunnel"), e.g. "tunnel" →
 *             child zone "tunnel.<root>".
 *   argv[3] — root domain (defaults to CLOUDFLARE_TUNNEL_ZONE env or
 *             "newcoworker.com").
 *
 * After it succeeds, follow the printed checklist to update
 * `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_TUNNEL_ZONE` in `.env` + Vercel.
 */

import { readFileSync } from "fs";

// Manual .env parser so the script runs without `dotenv`. Skips lines
// without `KEY=VALUE`, strips matching surrounding quotes, and never
// overwrites a value already in process.env (so an explicit shell
// export still wins).
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
  /* tolerable: assume env is exported in the shell */
}

import { ensureTunnelSubzone } from "@/lib/cloudflare/subzone";

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.length === 0) {
    console.error(`[ensure-tunnel-subzone] missing env: ${key}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const parentZoneId = requireEnv("CLOUDFLARE_ZONE_ID");

  const delegatedLabel = process.argv[2] ?? "tunnel";
  const parentZoneName =
    process.argv[3] ?? process.env.CLOUDFLARE_TUNNEL_ZONE ?? "newcoworker.com";

  console.log(
    `[ensure-tunnel-subzone] delegating ${delegatedLabel}.${parentZoneName} ` +
      `(parent zone id=${parentZoneId}, account=${accountId})`
  );

  const result = await ensureTunnelSubzone(
    { apiToken, accountId },
    { parentZoneName, parentZoneId, delegatedLabel }
  );

  console.log(`\n[ensure-tunnel-subzone] DONE.\n`);
  console.log(`  Child zone:        ${result.childZoneName}`);
  console.log(`  Child zone id:     ${result.childZoneId}`);
  console.log(`  Created on this run: ${result.childCreated}`);
  console.log(`  Nameservers:`);
  for (const ns of result.nameServers) {
    console.log(`    - ${ns}`);
  }
  console.log(`  NS delegation:     ${result.delegationCreated} created, ${result.delegationUpdated} updated, ${result.legacyDeletedFromParent} legacy records deleted`);
  console.log(
    `  CNAMEs migrated:   ${result.cnamesMigrated} new, ${result.cnamesAlreadyInChild} already in child, ${result.cnamesDeletedFromParent} removed from parent`
  );

  console.log(`\nNext steps:`);
  console.log(
    `  1. Wait ~5min for child zone status=active (parent NS records ` +
      `propagate quickly when both zones are on the same CF account).`
  );
  console.log(
    `  2. Update CLOUDFLARE_ZONE_ID -> ${result.childZoneId} ` +
      `in .env and Vercel (production / preview / development).`
  );
  console.log(
    `  3. Update CLOUDFLARE_TUNNEL_ZONE -> ${result.childZoneName} ` +
      `in .env and Vercel.`
  );
  console.log(
    `  4. Universal SSL on the child zone covers ${result.childZoneName} ` +
      `and *.${result.childZoneName} automatically (15min-24h to issue).`
  );
}

main().catch((err) => {
  console.error(
    `[ensure-tunnel-subzone] FATAL: ${err instanceof Error ? err.message : err}`
  );
  process.exit(1);
});
