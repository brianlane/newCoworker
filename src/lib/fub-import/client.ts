/**
 * Minimal Follow Up Boss API client, scoped to what the importer reads.
 *
 * Implemented against docs.followupboss.com/reference (fetched 2026-08-20):
 *   * Auth: HTTP Basic with the API key as the USERNAME and a blank
 *     password (reference/authentication). HTTPS only.
 *   * Identification: registered systems send X-System / X-System-Key on
 *     every request (reference/identification); we forward them from env
 *     when configured (FUB_X_SYSTEM / FUB_X_SYSTEM_KEY).
 *   * Pagination: limit (max 100) + offset, with a keyset `next` token in
 *     `_metadata` that FUB REQUIRES for deep result sets, so every pager
 *     here prefers `next` when the previous page returned one
 *     (reference/pagination).
 *   * Rate limits: sliding 10-second window (125 requests/window without a
 *     system key, and /v1/notes clamped to ~10). 429 responses carry
 *     Retry-After in seconds; requests are sequential (concurrency 1) and a
 *     429 waits then retries a few times (reference/rate-limiting).
 *
 * The API key is radioactive: it never appears in a URL (Basic auth header
 * only), never in an error message, and never in anything this module logs
 * (it logs nothing).
 */

export const FUB_API_BASE_URL = "https://api.followupboss.com/v1";

/** FUB's documented per-page maximum. */
export const FUB_PAGE_LIMIT = 100;

/** 429 retries before giving up on a request. */
const MAX_RATE_LIMIT_RETRIES = 3;

/** Fallback / ceiling for Retry-After waits, milliseconds. */
const DEFAULT_RETRY_AFTER_MS = 10_000;
const MAX_RETRY_AFTER_MS = 30_000;

/** Non-2xx from FUB. Message carries status + path, never the key or body. */
export class FubApiError extends Error {
  constructor(
    public readonly status: number,
    path: string
  ) {
    super(`Follow Up Boss API responded ${status} on ${path}`);
    this.name = "FubApiError";
  }
}

/** One page of a FUB collection plus the pagination facts the caller needs. */
export type FubPage<T> = {
  items: T[];
  /** `_metadata.total` when FUB sent one (the dry-run counts read this). */
  total: number | null;
  /** Keyset token for the next page; null on the last page. */
  next: string | null;
};

export type FubPerson = {
  id: number;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  stage?: string | null;
  source?: string | null;
  tags?: string[] | null;
  emails?: Array<{ value?: string | null }> | null;
  phones?: Array<{ value?: string | null }> | null;
};

export type FubNote = {
  id: number;
  personId?: number | null;
  subject?: string | null;
  body?: string | null;
  isHtml?: boolean | null;
  createdBy?: string | null;
  created?: string | null;
  updated?: string | null;
};

export type FubDeal = {
  id: number;
  name?: string | null;
  /** Deal value in DOLLARS (mapped to value_cents on our side). */
  price?: number | null;
  stageId?: number | null;
  pipelineId?: number | null;
  people?: Array<{ id?: number | null }> | null;
  projectedCloseDate?: string | null;
  /** Record state: Active / Archived / Deleted (not the pipeline stage). */
  status?: string | null;
  createdAt?: string | null;
  enteredStageAt?: string | null;
};

export type FubPipeline = {
  id: number;
  name?: string | null;
  stages?: Array<{ id?: number | null; name?: string | null }> | null;
};

export type FubStage = {
  id: number;
  name?: string | null;
  peopleCount?: number | null;
};

export type FubNamedThing = {
  id: number;
  name?: string | null;
  status?: string | null;
};

type PageParams = {
  limit?: number;
  offset?: number;
  /** FUB keyset token from the previous page's `_metadata.next`. */
  next?: string;
};

export type FubClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable wait so tests never sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  /** X-System / X-System-Key overrides (default: FUB_X_SYSTEM[_KEY] env). */
  system?: string | null;
  systemKey?: string | null;
};

export type FubClient = ReturnType<typeof createFubClient>;

/** Retry-After is in seconds; absent/garbage falls back, and waits are capped. */
export function retryAfterMs(header: string | null): number {
  const seconds = Number(header ?? "");
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/**
 * Pull the collection array out of a FUB list response. Each endpoint keys
 * its array by collection name ("people", "notes", ...); the fallback scan
 * covers casing drift (e.g. actionPlans vs actionplans) without guessing.
 */
export function extractCollection<T>(json: unknown, key: string): T[] {
  if (typeof json !== "object" || json === null) return [];
  const record = json as Record<string, unknown>;
  const direct = record[key];
  if (Array.isArray(direct)) return direct as T[];
  for (const [k, v] of Object.entries(record)) {
    if (k !== "_metadata" && Array.isArray(v)) return v as T[];
  }
  return [];
}

function extractMetadata(json: unknown): { total: number | null; next: string | null } {
  const meta =
    typeof json === "object" && json !== null
      ? ((json as Record<string, unknown>)._metadata as Record<string, unknown> | undefined)
      : undefined;
  const total = typeof meta?.total === "number" ? meta.total : null;
  const next = typeof meta?.next === "string" && meta.next.length > 0 ? meta.next : null;
  return { total, next };
}

/**
 * Build the client. All requests are sequential GETs (concurrency 1 by
 * construction: the importer awaits every call), authenticated per the FUB
 * Basic scheme, retried on 429 with the server's Retry-After.
 */
export function createFubClient(options: FubClientOptions) {
  const baseUrl = options.baseUrl ?? FUB_API_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const system = options.system !== undefined ? options.system : process.env.FUB_X_SYSTEM ?? null;
  const systemKey =
    options.systemKey !== undefined ? options.systemKey : process.env.FUB_X_SYSTEM_KEY ?? null;

  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${options.apiKey}:`).toString("base64")}`,
    Accept: "application/json",
    ...(system ? { "X-System": system } : {}),
    ...(systemKey ? { "X-System-Key": systemKey } : {})
  };

  async function request(path: string, params: Record<string, string | number | undefined>) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url.toString(), { method: "GET", headers });
      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(retryAfterMs(res.headers.get("Retry-After")));
        continue;
      }
      if (!res.ok) throw new FubApiError(res.status, path);
      return (await res.json()) as unknown;
    }
  }

  async function page<T>(
    path: string,
    key: string,
    params: PageParams & Record<string, string | number | undefined>
  ): Promise<FubPage<T>> {
    const { next, offset, limit, ...rest } = params;
    const json = await request(path, {
      ...rest,
      limit: limit ?? FUB_PAGE_LIMIT,
      // FUB enforces keyset pagination for deep sets: send `next` when the
      // previous page supplied one, offset only for the first page.
      ...(next ? { next } : { offset: offset ?? 0 })
    });
    const { total, next: nextToken } = extractMetadata(json);
    return { items: extractCollection<T>(json, key), total, next: nextToken };
  }

  return {
    /**
     * Cheap authenticated ping: GET /me returns the calling user. Used to
     * validate a pasted key before anything is stored.
     */
    ping: async (): Promise<{ name: string | null }> => {
      const json = await request("/me", {});
      const name =
        typeof json === "object" && json !== null && typeof (json as { name?: unknown }).name === "string"
          ? ((json as { name: string }).name as string)
          : null;
      return { name };
    },
    getPeople: (params: PageParams & { fields?: string }) =>
      page<FubPerson>("/people", "people", params),
    /** Batch person hydration for note/deal linkage (id filter, max 100). */
    getPeopleByIds: (ids: number[], fields: string) =>
      page<FubPerson>("/people", "people", {
        id: ids.join(","),
        fields,
        limit: FUB_PAGE_LIMIT
      }),
    getNotes: (params: PageParams) => page<FubNote>("/notes", "notes", params),
    getDeals: (params: PageParams) => page<FubDeal>("/deals", "deals", params),
    getPipelines: (params: PageParams) => page<FubPipeline>("/pipelines", "pipelines", params),
    getStages: (params: PageParams) => page<FubStage>("/stages", "stages", params),
    getSmartLists: (params: PageParams) =>
      page<FubNamedThing>("/smartLists", "smartlists", { ...params, all: "true" }),
    getActionPlans: (params: PageParams) =>
      page<FubNamedThing>("/actionPlans", "actionplans", params)
  };
}
