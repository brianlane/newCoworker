/**
 * Shared helpers for fleet SSH redeploy scripts (`redeploy-voice-bridge`,
 * `redeploy-deploy-client`). Keeps git-ref validation, Hostinger IP lookup,
 * and Supabase tenant listing in one place.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";

export type TenantVpsRedeployArgs = {
  ref: string;
  businessId: string | null;
  json: boolean;
};

export type TenantVpsTarget = {
  businessId: string;
  hostingerVpsId: string;
  tier: string;
};

export type TenantVpsRedeployResult = TenantVpsTarget & {
  ok: boolean;
  publicIp?: string;
  exitCode?: number;
  detail?: string;
  stdoutTail?: string;
};

/**
 * Validate a git ref for safe interpolation into single-quoted remote bash.
 * @see scripts/redeploy-voice-bridge.ts Bugbot PR #74 notes.
 */
export function assertSafeGitRef(ref: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith("-") || ref.includes("..")) {
    throw new Error(
      `unsafe git ref ${JSON.stringify(ref)}: must match /^[A-Za-z0-9._/-]+$/, not start with '-', and not contain '..'`
    );
  }
}

export function parseTenantVpsRedeployArgs(argv: string[], usageLine: string): TenantVpsRedeployArgs {
  const out: TenantVpsRedeployArgs = { ref: "main", businessId: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--ref") out.ref = argv[++i] ?? "main";
    else if (a === "--business") out.businessId = argv[++i] ?? null;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(usageLine);
      process.exit(0);
    }
  }
  assertSafeGitRef(out.ref);
  return out;
}

/**
 * Businesses with a Hostinger VPS id. Includes tier for full deploy-client runs.
 */
export async function listTenantVpsTargets(businessId: string | null): Promise<TenantVpsTarget[]> {
  const supabase = await createSupabaseServiceClient();
  let q = supabase
    .from("businesses")
    .select("id, hostinger_vps_id, tier")
    .not("hostinger_vps_id", "is", null);
  if (businessId) q = q.eq("id", businessId);
  const { data, error } = await q;
  if (error) throw new Error(`listTenantVpsTargets: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; hostinger_vps_id: string | null; tier: string | null }>)
    .filter((r) => typeof r.hostinger_vps_id === "string" && r.hostinger_vps_id.length > 0)
    .map((r) => ({
      businessId: r.id,
      hostingerVpsId: r.hostinger_vps_id as string,
      tier: typeof r.tier === "string" && r.tier.length > 0 ? r.tier : "standard"
    }));
}

export async function resolveTenantVpsPublicIp(
  hostingerVpsId: string,
  token: string,
  logPrefix: string
): Promise<string | null> {
  const client = new HostingerClient({
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token
  });
  try {
    const vm = await client.getVirtualMachine(Number(hostingerVpsId));
    return vm.ipv4?.[0]?.address ?? null;
  } catch (err) {
    process.stderr.write(
      `${logPrefix} hostinger getVirtualMachine ${hostingerVpsId} failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

/** {@link createSupabaseServiceClient} only reads NEXT_PUBLIC_SUPABASE_URL. */
export function ensureNextPublicSupabaseUrlOrExit(): void {
  const pub = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const alt = process.env.SUPABASE_URL?.trim();
  if (!pub && alt) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = alt;
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()) {
    process.stderr.write(
      "missing NEXT_PUBLIC_SUPABASE_URL (set it, or set SUPABASE_URL as an alias)\n"
    );
    process.exit(2);
  }
}

export function requireServiceRoleAndHostingerToken(): string {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    process.stderr.write("missing SUPABASE_SERVICE_ROLE_KEY\n");
    process.exit(2);
  }
  const hostingerToken = process.env.HOSTINGER_API_TOKEN ?? "";
  if (!hostingerToken) {
    process.stderr.write("missing HOSTINGER_API_TOKEN\n");
    process.exit(2);
  }
  return hostingerToken;
}
