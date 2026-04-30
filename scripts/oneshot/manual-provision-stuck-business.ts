#!/usr/bin/env tsx
/**
 * One-shot manual provisioner for biz `621a5b0d-c2ad-449f-9d74-9d50e7b27fa3`
 * (owner brianlanefanmail@gmail.com, paid + onboarded standard tier on
 * 2026-04-29). Two purposes:
 *
 *  1. Unblock the customer NOW. Their Stripe webhook fired
 *     `orchestrateProvisioning` against the deployed Vercel build, which
 *     still calls `createPostInstallScript` *before* purchasing a VPS. That
 *     POST returns `403 [VPS:2000] Unauthorized` for accounts that don't
 *     already own a VPS, so the call died there. The deployed orchestrator
 *     also lacked a top-level catch that records a `failed` row in
 *     `coworker_logs`, so the dashboard sat at `started`/5% indefinitely.
 *     We invoke the LOCAL refactored orchestrator (which skips
 *     `createPostInstallScript` entirely and SSH-bootstraps the VPS after
 *     it boots) end-to-end against production secrets — the customer ends
 *     up with the same artefact they would have gotten from the deployed
 *     code post-merge.
 *
 *  2. Validate / invalidate the "post-install-scripts is gated until you
 *     own a VPS" hypothesis. Once the orchestrator has bought a VM for
 *     this account, we probe `POST /api/vps/v1/post-install-scripts`
 *     once. If it returns 200 the gate clears at first-purchase and a
 *     follow-up change can move bootstrap back into Hostinger's first-boot
 *     hook (using `/recreate` for idempotency on previously-provisioned
 *     VPSes). If it still 403s, the gate is something else (account tier,
 *     support ticket, something undocumented) and we contact Hostinger.
 *
 * Pre-flight assumptions (verified manually before running):
 *   - .env contains the *current* HOSTINGER_API_TOKEN
 *     (`p2KX...`). The previous token (`77l0...`) was revoked.
 *   - Hostinger account has no orphan KVM (`GET /virtual-machines`
 *     returns `[]`), so this run will purchase the first real VM and
 *     no double-charge is possible.
 *   - Subscription `sub_1TRfjvFv205jOP2fzahmHdfT` is `active`.
 *   - `business_configs.soul_md/identity_md/memory_md` already populated
 *     by the onboarding chat.
 *   - No row in `vps_ssh_keys` or `telnyx_voice_routes` for this biz
 *     (so DID auto-purchase will fire and charge ~$1).
 *
 * Usage:
 *   set -a; source .env; set +a; npx tsx scripts/manual-provision-stuck-business.ts
 *
 * NOT a long-term tool — delete or fold into a proper admin route once
 * the orchestrator changes ship to Vercel.
 */
import {
  HostingerClient,
  HostingerApiError,
  DEFAULT_HOSTINGER_BASE_URL
} from "@/lib/hostinger/client";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";

const BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const TIER = "standard" as const;
const OWNER_EMAIL = "brianlanefanmail@gmail.com";

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[manual-provision] missing env: ${key}`);
    process.exit(2);
  }
  return v;
}

function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${(s % 60).toFixed(0).padStart(2, "0")}s`;
}

async function main(): Promise<void> {
  requireEnv("HOSTINGER_API_TOKEN");
  requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  requireEnv("ROWBOAT_GATEWAY_TOKEN");

  console.log(
    `[manual-provision] target biz=${BUSINESS_ID} tier=${TIER} owner=${OWNER_EMAIL}`
  );
  console.log(
    `[manual-provision] env summary: ` +
      `hostinger=${process.env.HOSTINGER_API_TOKEN!.slice(0, 8)}…(len ${process.env.HOSTINGER_API_TOKEN!.length}), ` +
      `auto_did=${process.env.TELNYX_AUTO_PURCHASE_DID}, ` +
      `cf=${process.env.CLOUDFLARE_API_TOKEN ? "set" : "missing"}, ` +
      `voice_origin=${process.env.BRIDGE_MEDIA_WSS_ORIGIN}`
  );

  const t0 = Date.now();
  console.log(`[manual-provision] invoking orchestrateProvisioning...`);
  let result;
  try {
    result = await orchestrateProvisioning({
      businessId: BUSINESS_ID,
      tier: TIER,
      ownerEmail: OWNER_EMAIL
    });
  } catch (err) {
    console.error(
      `[manual-provision] orchestration FAILED after ${fmtDuration(Date.now() - t0)}:`
    );
    if (err instanceof HostingerApiError) {
      console.error(
        `  HostingerApiError: ${err.endpoint} → HTTP ${err.status} — ${err.message}`
      );
      console.error(`  body:`, err.body);
    } else if (err instanceof Error) {
      console.error(`  ${err.name}: ${err.message}`);
      if (err.stack) console.error(err.stack);
    } else {
      console.error(err);
    }
    process.exit(1);
  }

  console.log(
    `[manual-provision] orchestration COMPLETE after ${fmtDuration(Date.now() - t0)}:`,
    result
  );

  // ---------------- HYPOTHESIS PROBE ----------------
  // Now that we own a VPS, retry POST /post-install-scripts. This is the
  // single observation the user asked for: does the 403 clear once an
  // active VM exists on the account?
  const client = new HostingerClient({
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token: process.env.HOSTINGER_API_TOKEN!,
    userAgent: "newcoworker-manual-provision/1.0"
  });

  const probeName = `hypothesis-probe-${Date.now()}`;
  const probeBody = "#!/bin/bash\nset -e\necho hypothesis-probe-noop\n";
  console.log(
    `\n[manual-provision] HYPOTHESIS PROBE: POST /api/vps/v1/post-install-scripts ` +
      `(name=${probeName})`
  );
  try {
    const created = await client.createPostInstallScript(probeName, probeBody);
    console.log(
      `[manual-provision] HYPOTHESIS CONFIRMED ✅ — endpoint now accepts ` +
        `(created id=${created.id}). The account-level gate clears once a ` +
        `VPS is owned. Future iteration: revert orchestrator to first-boot ` +
        `post-install hook for new customers; keep the SSH-bootstrap path ` +
        `as a fallback for the very first VPS on a fresh account.`
    );
    try {
      await client.deletePostInstallScript(created.id);
      console.log(`[manual-provision] cleanup: deleted probe id=${created.id}`);
    } catch (cleanupErr) {
      console.warn(
        `[manual-provision] cleanup failed for probe id=${created.id}:`,
        cleanupErr
      );
    }
  } catch (err) {
    if (err instanceof HostingerApiError && err.status === 403) {
      console.log(
        `[manual-provision] HYPOTHESIS REJECTED ❌ — endpoint still 403 ` +
          `even with an owned VPS. body=`,
        err.body
      );
      console.log(
        `[manual-provision] VERDICT: SSH-bootstrap refactor is REQUIRED. ` +
          `Open a Hostinger support ticket about the deeper gate.`
      );
    } else if (err instanceof HostingerApiError) {
      console.log(
        `[manual-provision] probe error (HTTP ${err.status} ${err.endpoint}): ${err.message}`,
        err.body
      );
    } else {
      console.log(`[manual-provision] probe error (unknown):`, err);
    }
  }
}

main().catch((err) => {
  console.error("[manual-provision] FATAL:", err);
  process.exit(1);
});
