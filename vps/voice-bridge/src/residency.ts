/**
 * Residency read routing for the voice bridge.
 *
 * The bridge is the ONE caller that does not have to leave the box. It runs
 * on the tenant's own VPS, and for a residency tenant the datastore runs on
 * that same VPS. So where the dashboard reaches the data API across a
 * Cloudflare tunnel and the Deno workers reach it across the public
 * internet, this is a hop between two containers on one host: no tunnel, no
 * public egress, and no central round-trip to look up a credential.
 *
 * NOT 127.0.0.1, and this is the trap. The data API publishes
 * `127.0.0.1:8091` for cloudflared, which is a HOST process. The bridge is a
 * CONTAINER, so its own 127.0.0.1 is itself, and `host.docker.internal`
 * lands on the docker-bridge IP where nothing is listening. That exact
 * mistake caused the May 2026 outage documented in
 * vps/voice-bridge/docker-compose.yml, where every Rowboat fetch hung 30s
 * before failing. Sibling containers use Docker DNS on the shared
 * `rowboat_default` network, the same way this service already reaches
 * `rowboat:3000`.
 *
 * The credential is already here too. deploy-client.sh sets
 * `DATA_API_TOKENS=${DATA_API_TOKENS:-${ROWBOAT_GATEWAY_TOKEN}}`, and the
 * bridge already reads ROWBOAT_GATEWAY_TOKEN for its Rowboat calls, so the
 * token this service presents is one the data API accepts by construction.
 *
 * WHAT IS ROUTED, and what is not. `sms_outbound_log` and
 * `voice_call_transcripts` are PURGED from central at cutover, so a central
 * read of them for a vps tenant is not stale, it is empty: the receptionist
 * is told this caller has never written or called. `contacts` is KEPT
 * central and stays central, because central is the write ingress and the
 * box copy can only ever LAG it (see the shared module, and PR #1574 where
 * routing that read box-ward was reverted for exactly this reason).
 *
 * FAILURE POSTURE: every read here is best-effort and returns null on any
 * failure, which each caller already treats as "that source is missing".
 * A live phone call must never fail because a history lookup did, and the
 * on-host hop makes the failure narrow anyway: if the datastore on this box
 * is down, the bridge on the same box has larger problems already.
 *
 * Dependency-free on purpose, like its sibling modules here, so repo-root
 * tests and typecheck can import it without the bridge's VPS-only runtime
 * deps.
 */

/**
 * Docker DNS name of the data API on the shared `rowboat_default` network.
 * See the header: 127.0.0.1 is this container, not the host.
 */
export const DEFAULT_DATA_API_BASE_URL = "http://data-api:8091";

export type VoiceDataApiFilterOp =
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

export type VoiceDataApiCondition = {
  column: string;
  op: VoiceDataApiFilterOp;
  value: string | number | boolean | null | Array<string | number>;
  negate?: boolean;
};

export type VoiceDataApiFilter = VoiceDataApiCondition | { or: VoiceDataApiCondition[][] };

export type VoiceDataApiSelectRequest = {
  table: string;
  columns?: string[];
  filters?: VoiceDataApiFilter[];
  order?: Array<{ column: string; ascending: boolean; nullsFirst?: boolean }>;
  limit?: number;
};

/** Minimal structural client, the convention the sibling modules use. */
type ModeSupabase = {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string
      ): {
        maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
};

export type VoiceResidencyDeps = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
};

const MODE_TTL_MS = 30_000;
const modeCache = new Map<string, { vps: boolean; expiresAt: number }>();

/** Test hook, clears the TTL cache between cases. */
export function __clearVoiceResidencyModeCache(): void {
  modeCache.clear();
}

/**
 * True when this tenant's purged content must come from the box datastore.
 *
 * Cached for 30s, matching the dashboard and Deno mirrors, so a bridge
 * handling several calls does not re-ask per call. Fails toward central on
 * any error and does NOT cache that guess: a mode lookup blipping must not
 * pin a whole isolate to the wrong answer for half a minute.
 */
export async function voiceIsVpsReadMode(
  supabase: ModeSupabase,
  businessId: string
): Promise<boolean> {
  const cached = modeCache.get(businessId);
  if (cached && cached.expiresAt > Date.now()) return cached.vps;
  try {
    const { data, error } = await supabase
      .from("businesses")
      .select("data_residency_mode")
      .eq("id", businessId)
      .maybeSingle();
    if (error) return false;
    const raw = (data as { data_residency_mode?: string } | null)?.data_residency_mode;
    const vps = raw === "vps";
    modeCache.set(businessId, { vps, expiresAt: Date.now() + MODE_TTL_MS });
    return vps;
  } catch {
    return false;
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Read rows from the box datastore over loopback.
 *
 * Returns null on ANY failure, which callers treat as "this source is
 * missing" exactly as they already treat a central query error. Null is
 * deliberately distinguishable from `[]`: an empty array means the datastore
 * answered and had nothing, which is a fact the timeline can act on.
 *
 * The timeout is 5s rather than the 10s the off-box clients use. This is an
 * on-host call placed while a caller is on the line; if it has not answered
 * in five seconds it is not going to help this call.
 */
export async function voiceReadMovedRowsOrNull<Row = Record<string, unknown>>(
  request: VoiceDataApiSelectRequest,
  deps: VoiceResidencyDeps = {}
): Promise<Row[] | null> {
  // `??` would NOT fall through here: deploy-client.sh writes a literal
  // `DATA_API_TOKENS=` on every non-residency box, and "" is not nullish, so
  // nullish-coalescing would pin the bearer to the empty string and every
  // read would return null with the fallback never consulted.
  const firstNonEmpty = (...candidates: Array<string | undefined>): string =>
    candidates.map((c) => c?.split(",")[0]?.trim() ?? "").find((c) => c.length > 0) ?? "";
  const token =
    deps.token ??
    firstNonEmpty(process.env.DATA_API_TOKENS, process.env.ROWBOAT_GATEWAY_TOKEN);
  if (!token) {
    console.error(`[residency] no data-api token on this box for ${request.table}`);
    return null;
  }
  const baseUrl = deps.baseUrl ?? process.env.DATA_API_BASE_URL ?? DEFAULT_DATA_API_BASE_URL;
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(`${baseUrl}/v1/select`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
      signal: controller.signal
    });
    if (!res.ok) {
      console.error(`[residency] box read of ${request.table} failed: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as
      | { ok: true; rows: Row[] }
      | { ok: false; error: string; message: string };
    if (!json.ok) {
      // Server-side failures come back HTTP 200 + ok:false, so treating a
      // 200 as success would hand the caller [] and read as "this caller has
      // no history" rather than "the lookup failed".
      console.error(`[residency] box read of ${request.table} failed: ${json.error}: ${json.message}`);
      return null;
    }
    return json.rows ?? [];
  } catch (err) {
    console.error(
      `[residency] box read of ${request.table} failed:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
