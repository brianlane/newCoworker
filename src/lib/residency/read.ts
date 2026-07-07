/**
 * Residency read routing (Phase B3).
 *
 * For a tenant in `data_residency_mode = 'vps'`, dashboard reads of moved
 * content come from the tenant's box-local data API. Everyone else —
 * including 'dual' tenants, where central Supabase remains the source of
 * truth while the journal replicates box-ward — reads central exactly as
 * before.
 *
 * WORST-CASE posture: there is deliberately NO silent fallback to central
 * for a vps-mode tenant. After the Phase 4 purge central has nothing to
 * fall back to, and before it a fallback would quietly serve rows the box
 * may have moved past — masking exactly the divergence the parity gate is
 * supposed to catch. A down box therefore surfaces as a loud, typed
 * {@link ResidencyReadError} the route can turn into an honest 503.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { DataApiClient, DataApiTransportError } from "@/lib/residency/client";
import type { DataApiSelectRequest } from "@/lib/residency/contract";
import type { DataResidencyMode } from "@/lib/residency/tier-gate";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export class ResidencyReadError extends Error {
  readonly businessId: string;
  constructor(businessId: string, message: string) {
    super(message);
    this.name = "ResidencyReadError";
    this.businessId = businessId;
  }
}

/**
 * Mode cache. Dashboard pages call several db helpers per render; without a
 * cache each would pay a businesses lookup. 30s TTL bounds how long an admin
 * mode flip takes to reach read routing — acceptable for a maintenance
 * action that is already gated behind backfill/parity steps.
 */
const MODE_TTL_MS = 30_000;
const modeCache = new Map<string, { mode: DataResidencyMode; expiresAt: number }>();

/** Test hook — clears the TTL cache between cases. */
export function __clearResidencyModeCache(): void {
  modeCache.clear();
}

export async function residencyModeFor(
  businessId: string,
  client?: SupabaseClient
): Promise<DataResidencyMode> {
  const cached = modeCache.get(businessId);
  if (cached && cached.expiresAt > Date.now()) return cached.mode;
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("data_residency_mode")
    .eq("id", businessId)
    .maybeSingle();
  if (error) {
    // Fail toward central: mode resolution breaking must not take every
    // dashboard read down with it. A residency tenant whose mode row is
    // unreadable gets central rows — which still exist until Phase 4, and
    // Phase 4's purge runbook re-verifies mode reachability first.
    return "supabase";
  }
  const raw = (data as { data_residency_mode?: string } | null)?.data_residency_mode;
  const mode: DataResidencyMode =
    raw === "vps" || raw === "dual" ? raw : "supabase";
  modeCache.set(businessId, { mode, expiresAt: Date.now() + MODE_TTL_MS });
  return mode;
}

/** True when this tenant's content reads must come from their box. */
export async function isVpsReadMode(
  businessId: string,
  client?: SupabaseClient
): Promise<boolean> {
  return (await residencyModeFor(businessId, client)) === "vps";
}

export type ReadDeps = {
  /** Injectable for tests / port-forwarded smoke runs. */
  makeDataApi?: (businessId: string) => DataApiClient;
};

/**
 * Read rows from the tenant's box datastore. Throws {@link ResidencyReadError}
 * on transport failure OR a structured server-side failure — both mean the
 * authoritative copy is unreachable, and per the worst-case posture that is
 * an error, not a fallback.
 */
export async function readMovedRows<Row = Record<string, unknown>>(
  businessId: string,
  request: DataApiSelectRequest,
  deps: ReadDeps = {}
): Promise<Row[]> {
  const api = deps.makeDataApi
    ? deps.makeDataApi(businessId)
    : new DataApiClient(businessId);
  try {
    const res = await api.select<Row>(request);
    if (!res.ok) {
      throw new ResidencyReadError(
        businessId,
        `residency read of ${request.table} failed: ${res.error}: ${res.message}`
      );
    }
    return res.rows;
  } catch (err) {
    if (err instanceof ResidencyReadError) throw err;
    if (err instanceof DataApiTransportError) {
      throw new ResidencyReadError(businessId, err.message);
    }
    throw err;
  }
}

/**
 * COUNT over the box datastore (same worst-case semantics as
 * {@link readMovedRows}: unreachable box = typed error, no fallback).
 */
export async function countMovedRows(
  businessId: string,
  request: Omit<DataApiSelectRequest, "count" | "limit" | "columns">,
  deps: ReadDeps = {}
): Promise<number> {
  const api = deps.makeDataApi
    ? deps.makeDataApi(businessId)
    : new DataApiClient(businessId);
  try {
    const res = await api.select({ ...request, columns: ["id"], limit: 1, count: true });
    if (!res.ok) {
      throw new ResidencyReadError(
        businessId,
        `residency count of ${request.table} failed: ${res.error}: ${res.message}`
      );
    }
    return res.count ?? 0;
  } catch (err) {
    if (err instanceof ResidencyReadError) throw err;
    if (err instanceof DataApiTransportError) {
      throw new ResidencyReadError(businessId, err.message);
    }
    throw err;
  }
}

/**
 * Escape `\`, `%`, and `_` so a literal value can be used as an anchored
 * ILIKE pattern (the data-api parameterizes the value; PostgreSQL's default
 * LIKE escape character is backslash, so backslash-escaping the metachars —
 * and any literal backslash first — yields an exact, case-insensitive
 * match). Callers matching identities should still post-filter on exact
 * equality; ILIKE here only buys case-insensitivity.
 */
export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
