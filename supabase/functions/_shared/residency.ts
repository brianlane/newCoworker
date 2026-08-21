/**
 * Residency read routing for the Deno edge workers.
 *
 * The dashboard has had this since PR #1563/#1565: for a tenant in
 * `data_residency_mode = 'vps'`, content reads come from that tenant's own
 * box rather than central Supabase. The ENGINE never did, so the inbound
 * text-message path, which is where automations actually fire, kept reading
 * central. That was the last real gap in the residency program.
 *
 * This module mirrors src/lib/residency/{tables,contract,client,read}.ts the
 * same way `gateway_token.ts` mirrors src/lib/rowboat/gateway-token.ts: the
 * edge runtime cannot import from `@/lib/*`, so the moved-table list and the
 * wire types are duplicated here and pinned by
 * tests/residency-edge-lockstep.test.ts. Change one, change both.
 *
 * FAILURE POSTURE, and why it is not uniform.
 *
 * `edgeReadMovedRows` THROWS a typed EdgeResidencyReadError. It never falls
 * back to central: after the Phase 4 purge central has nothing to fall back
 * to, and before it, falling back would serve rows the box has moved past.
 * What each CALLER does with that is a per-call-site decision, because the
 * right answer genuinely differs:
 *
 *   * A read whose result the reply DEPENDS on (customer memory, the flow
 *     definition about to run) should let it throw. `sms_inbound_jobs` has
 *     attempt_count and a dead_letter status, so the job retries and the
 *     customer is answered LATE. Answering on time from the wrong data is
 *     worse than answering late.
 *   * A read that only SUPPRESSES something (a dedupe check, a repage guard)
 *     should swallow and default to its documented safe value. Throwing
 *     there would fail a whole conversation to avoid a duplicate alert.
 *
 * Callers pick with `edgeReadMovedRowsOrNull`, which is the swallow variant,
 * so the choice is visible in the call rather than buried in this module.
 */

/**
 * Tenant content that moves to the box. Lockstep mirror of
 * RESIDENCY_MOVED_TABLES in src/lib/residency/tables.ts, same order.
 */
export const EDGE_RESIDENCY_MOVED_TABLES = [
  "contacts",
  "dashboard_chat_threads",
  "dashboard_chat_messages",
  "dashboard_chat_activity",
  "email_log",
  "voice_call_transcripts",
  "voice_call_transcript_turns",
  "voice_outbound_dial_log",
  "sms_outbound_log",
  "sms_rowboat_threads",
  "sms_owner_reply_prompts",
  "scheduled_sms",
  "notifications",
  "ai_flows",
  "aiflow_url_memory"
] as const;

export type EdgeResidencyMovedTable = (typeof EDGE_RESIDENCY_MOVED_TABLES)[number];

/** Wire grammar mirror. The box validates; these types keep callers honest. */
export type EdgeDataApiFilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "in"
  | "is"
  | "contains"
  | "overlaps";

export type EdgeDataApiCondition = {
  column: string;
  op: EdgeDataApiFilterOp;
  value: string | number | boolean | null | Array<string | number>;
  negate?: boolean;
};

/** One level of OR: inner arrays are ANDed, the outer list ORed. */
export type EdgeDataApiFilter = EdgeDataApiCondition | { or: EdgeDataApiCondition[][] };

export type EdgeDataApiSelectRequest = {
  table: EdgeResidencyMovedTable;
  columns?: string[];
  filters?: EdgeDataApiFilter[];
  order?: Array<{ column: string; ascending: boolean; nullsFirst?: boolean }>;
  limit?: number;
  offset?: number;
};

export class EdgeResidencyReadError extends Error {
  readonly businessId: string;
  constructor(businessId: string, message: string) {
    super(message);
    this.name = "EdgeResidencyReadError";
    this.businessId = businessId;
  }
}

/**
 * Runtime-agnostic env read (Deno on the edge, Node under Vitest), the same
 * shape `sharedEnvRowboatBearer` in gateway_token.ts uses so the Node tsc
 * program stays happy without a Deno types dependency.
 */
function env(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env: { get(name: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno ? g.Deno.env.get(name) : g.process?.env?.[name];
}

/**
 * `https://data-<businessId>.<suffix>`. Mirrors residencyDataBaseUrl in
 * src/lib/residency/client.ts, INCLUDING the blank-coercion: an env var set
 * to an empty string must fall through to the next candidate, not produce
 * `https://data-<id>.`.
 */
export function edgeResidencyDataBaseUrl(businessId: string): string {
  const blank = (v: string | undefined): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t.length === 0 ? undefined : t;
  };
  const suffix =
    blank(env("CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX")) ??
    blank(env("CLOUDFLARE_TUNNEL_ZONE")) ??
    "newcoworker.com";
  return `https://data-${businessId}.${suffix}`;
}

/** Minimal structural client, the convention _shared/gateway_token.ts uses. */
type ResidencySupabase = {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string
      ): {
        is(
          column: string,
          value: null
        ): {
          not(
            column: string,
            op: string,
            value: null
          ): {
            order(
              column: string,
              opts: { ascending: boolean }
            ): {
              limit(n: number): {
                maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
              };
            };
          };
        };
        maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
};

export type EdgeResidencyMode = "supabase" | "dual" | "vps";

/**
 * Mode cache, per isolate. A worker drains several jobs per invocation and
 * each one would otherwise pay a businesses lookup. 30s matches the Next
 * side's MODE_TTL_MS, so an admin mode flip reaches both at the same pace.
 */
const MODE_TTL_MS = 30_000;
const modeCache = new Map<string, { mode: EdgeResidencyMode; expiresAt: number }>();

/** Test hook, clears the TTL cache between cases. */
export function __clearEdgeResidencyModeCache(): void {
  modeCache.clear();
}

export async function edgeResidencyMode(
  supabase: ResidencySupabase,
  businessId: string
): Promise<EdgeResidencyMode> {
  const cached = modeCache.get(businessId);
  if (cached && cached.expiresAt > Date.now()) return cached.mode;
  try {
    const { data, error } = await supabase
      .from("businesses")
      .select("data_residency_mode")
      .eq("id", businessId)
      .maybeSingle();
    // Fail toward central, and do NOT cache the guess: mode resolution
    // breaking must not take the whole inbound path down with it, and the
    // next job should re-ask rather than inherit a 30s-old fallback.
    if (error) return "supabase";
    const raw = (data as { data_residency_mode?: string } | null)?.data_residency_mode;
    const mode: EdgeResidencyMode = raw === "vps" || raw === "dual" ? raw : "supabase";
    modeCache.set(businessId, { mode, expiresAt: Date.now() + MODE_TTL_MS });
    return mode;
  } catch {
    return "supabase";
  }
}

/** True when this tenant's content reads must come from their box. */
export async function edgeIsVpsReadMode(
  supabase: ResidencySupabase,
  businessId: string
): Promise<boolean> {
  return (await edgeResidencyMode(supabase, businessId)) === "vps";
}

/**
 * The tenant's CONFIRMED-deployed gateway token.
 *
 * No shared-env fallback, unlike the Rowboat resolver next door. The box's
 * data-api validates per-tenant tokens only, so presenting the shared env
 * secret would earn a 401 that reads to the caller as "box down" rather than
 * "wrong credential". Null means "cannot authenticate", which the caller
 * turns into a typed read error naming the real cause.
 */
export async function edgeConfirmedGatewayToken(
  supabase: ResidencySupabase,
  businessId: string
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("vps_gateway_tokens")
      .select("token")
      .eq("business_id", businessId)
      .is("revoked_at", null)
      .not("deployed_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return null;
    const token = (data as { token?: string } | null)?.token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export type EdgeReadDeps = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Test seam; production resolves the token from vps_gateway_tokens. */
  token?: string;
  baseUrl?: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Read rows from the tenant's box.
 *
 * Throws EdgeResidencyReadError on ANY failure: transport, auth, or a
 * structured `{ ok: false }` from the service. The tunnel replaces origin
 * 5xx bodies, so the data-api answers server-side failures with HTTP 200 and
 * ok:false; treating that as success would hand the caller an empty array
 * that reads as "this customer has never written to us".
 */
export async function edgeReadMovedRows<Row = Record<string, unknown>>(
  supabase: ResidencySupabase,
  businessId: string,
  request: EdgeDataApiSelectRequest,
  deps: EdgeReadDeps = {}
): Promise<Row[]> {
  const token = deps.token ?? (await edgeConfirmedGatewayToken(supabase, businessId));
  if (!token) {
    throw new EdgeResidencyReadError(
      businessId,
      `residency read of ${request.table} cannot authenticate: no confirmed gateway token`
    );
  }
  const baseUrl = deps.baseUrl ?? edgeResidencyDataBaseUrl(businessId);
  /* v8 ignore next -- bare global fetch is the production default; tests always inject fetchImpl */
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(`${baseUrl}/v1/select`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });
    if (!res.ok) {
      throw new EdgeResidencyReadError(
        businessId,
        `residency read of ${request.table} failed: HTTP ${res.status}`
      );
    }
    const json = (await res.json()) as
      | { ok: true; rows: Row[] }
      | { ok: false; error: string; message: string };
    if (!json.ok) {
      throw new EdgeResidencyReadError(
        businessId,
        `residency read of ${request.table} failed: ${json.error}: ${json.message}`
      );
    }
    return json.rows ?? [];
  } catch (err) {
    if (err instanceof EdgeResidencyReadError) throw err;
    throw new EdgeResidencyReadError(
      businessId,
      `residency read of ${request.table} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Swallow variant, for reads that only SUPPRESS something.
 *
 * Returns null when the box is unreachable, so the caller can fall back to
 * its documented safe default. Use this ONLY where a null result degrades
 * gracefully, never where the reply depends on the rows: null and "no rows"
 * are indistinguishable to the caller, which is exactly the silent-empty
 * failure the residency guard exists to prevent when the data matters.
 */
export async function edgeReadMovedRowsOrNull<Row = Record<string, unknown>>(
  supabase: ResidencySupabase,
  businessId: string,
  request: EdgeDataApiSelectRequest,
  deps: EdgeReadDeps = {}
): Promise<Row[] | null> {
  try {
    return await edgeReadMovedRows<Row>(supabase, businessId, request, deps);
  } catch (err) {
    // Always an EdgeResidencyReadError: edgeReadMovedRows wraps every
    // failure, including a non-Error throw, before it escapes. So there is no
    // non-Error branch to handle here, and adding one would be dead code.
    console.warn(
      `[residency] box read of ${request.table} for ${businessId} failed, using the safe default:`,
      (err as Error).message
    );
    return null;
  }
}
