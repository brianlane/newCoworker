/**
 * Tier cap on Nango workspace connections (`workspace_oauth_connections`).
 *
 * Why: every Nango connection consumes the platform's ACCOUNT-WIDE Nango
 * quota (10 on the free plan), so unmetered per-tenant connects would let a
 * single business exhaust the pool for everyone. Starter gets 1, Standard 3,
 * Enterprise unlimited — per-deal overridable via
 * `businesses.enterprise_limits.workspaceConnectionsMax` (same patch
 * mechanism as the other enterprise limits).
 *
 * Grandfathering: the cap gates NEW connects only. Existing rows keep
 * working (the proxy / email / calendar paths are untouched) and
 * re-completing an EXISTING connection is always allowed, so a tenant
 * already over a lowered cap is never wedged — they just can't add more.
 *
 * The gate lives server-side (same pattern as src/lib/residency/tier-gate.ts)
 * so the connect-session and connect-complete routes enforce it regardless
 * of what the UI shows.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import { getTierLimits } from "@/lib/plans/limits";
import type { PlanTier } from "@/lib/plans/tier";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type WorkspaceConnectionCapState = {
  /** Connections currently stored for the business. */
  used: number;
  /** Plan cap; null = unlimited. */
  max: number | null;
  atCap: boolean;
};

function isPlanTier(value: unknown): value is PlanTier {
  return value === "starter" || value === "standard" || value === "enterprise";
}

/**
 * Pure cap computation. An unknown/missing tier is treated as starter (the
 * most conservative cap) — the connect routes should never mint quota for a
 * business whose plan can't be established.
 */
export function workspaceConnectionCapState(
  tier: string | null | undefined,
  used: number,
  enterpriseLimitsOverride?: unknown
): WorkspaceConnectionCapState {
  const resolved: PlanTier = isPlanTier(tier) ? tier : "starter";
  const max = getTierLimits(resolved, enterpriseLimitsOverride).workspaceConnectionsMax;
  if (!Number.isFinite(max)) return { used, max: null, atCap: false };
  return { used, max, atCap: used >= max };
}

/** Owner-facing refusal copy (rendered verbatim by the connect banner). */
export function workspaceConnectionCapMessage(state: WorkspaceConnectionCapState): string {
  const max = state.max ?? 0;
  const noun = max === 1 ? "workspace connection" : "workspace connections";
  return `Your plan includes ${max} ${noun} (${state.used} in use). Remove one or upgrade your plan to connect another.`;
}

export class WorkspaceConnectionCapError extends Error {
  readonly state: WorkspaceConnectionCapState;

  constructor(state: WorkspaceConnectionCapState) {
    super(workspaceConnectionCapMessage(state));
    this.name = "WorkspaceConnectionCapError";
    this.state = state;
  }
}

/** Reads the business's tier (+ enterprise override) and counts its connections. */
export async function resolveWorkspaceConnectionCapState(
  businessId: string,
  client?: SupabaseClient
): Promise<WorkspaceConnectionCapState> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier, enterprise_limits")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`resolveWorkspaceConnectionCapState: ${error.message}`);
  const row = data as { tier?: string | null; enterprise_limits?: unknown } | null;
  const rows = await listWorkspaceOAuthConnections(businessId, db);
  return workspaceConnectionCapState(row?.tier, rows.length, row?.enterprise_limits ?? undefined);
}

/**
 * Throws {@link WorkspaceConnectionCapError} when the business cannot add
 * another workspace connection. A DB read error propagates (fail closed —
 * the connect can be retried; silently minting quota cannot be undone).
 */
export async function assertWorkspaceConnectionAllowed(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const state = await resolveWorkspaceConnectionCapState(businessId, client);
  if (state.atCap) throw new WorkspaceConnectionCapError(state);
}

export type WorkspaceConnectionInsertSettlement = {
  state: WorkspaceConnectionCapState;
  /**
   * Row id the caller must evict because the insert landed past the cap;
   * null = the row fits (or the cap is unlimited).
   */
  evictRowId: string | null;
};

/**
 * Post-insert cap settlement, closing the connect race (Bugbot on the cap
 * PR): the pre-insert check reads a count and later upserts without a
 * transaction, so two parallel connects can BOTH pass it. Called after the
 * upsert, this re-reads the rows in deterministic order (created_at, id)
 * and tells the caller to evict its own row when it landed past the cap —
 * seats belong to the earliest rows, so the final state can never exceed
 * the cap no matter how many connects race. A racer that over-evicts on a
 * created_at tie only leaves the tenant UNDER the cap (safe direction).
 */
export async function settleWorkspaceConnectionInsert(
  businessId: string,
  link: { providerConfigKey: string; connectionId: string },
  client?: SupabaseClient
): Promise<WorkspaceConnectionInsertSettlement> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("tier, enterprise_limits")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`settleWorkspaceConnectionInsert: ${error.message}`);
  const row = data as { tier?: string | null; enterprise_limits?: unknown } | null;
  const rows = await listWorkspaceOAuthConnections(businessId, db);
  const state = workspaceConnectionCapState(row?.tier, rows.length, row?.enterprise_limits ?? undefined);
  if (state.max === null) return { state, evictRowId: null };

  const ordered = [...rows].sort(
    (a, b) =>
      Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id)
  );
  const idx = ordered.findIndex(
    (r) =>
      r.provider_config_key === link.providerConfigKey && r.connection_id === link.connectionId
  );
  // idx === -1: the row is already gone (a concurrent delete) — nothing to
  // evict. Otherwise the row keeps its seat only inside the first `max`.
  if (idx === -1 || idx < state.max) return { state, evictRowId: null };
  return { state, evictRowId: ordered[idx].id };
}
