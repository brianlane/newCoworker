/**
 * system_logs persistence — the unified operational log sink.
 *
 * Every component that serves a client's AI writes here (Edge functions, the
 * VPS chat-worker, Telnyx webhooks, the app itself) so the admin business page
 * and the fleet-wide error feed can answer "why did this client's AI fail?"
 * without SSH-ing into a VPS. Schema: 20260610010000_system_logs.sql.
 *
 * Use `recordSystemLog` from instrumentation call sites: it is fire-and-forget
 * and NEVER throws — logging must never take down the path it observes.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type SystemLogLevel = "debug" | "info" | "warn" | "error";

export type SystemLogRow = {
  id: number;
  business_id: string | null;
  source: string;
  level: SystemLogLevel;
  event: string;
  message: string;
  payload: Record<string, unknown>;
  created_at: string;
};

const LOG_COLS = "id,business_id,source,level,event,message,payload,created_at";

/**
 * Build the PostgREST `or=(...)` filter that searches `event` and `message` for
 * a literal substring.
 *
 * This used to be `search.replace(/[%_,()]/g, "")` — the five characters that
 * are dangerous here were simply DELETED. Every event name in this system is
 * snake_case, so that quietly broke the search for the exact strings an operator
 * is most likely to paste: `ai_flow_run_failed` became `aiflowrunfailed` and
 * returned zero rows with no warning, which reads identically to "there were no
 * such failures". It cost real time during the Aug 4 2026 Clever incident.
 *
 * The five characters are dangerous for two unrelated reasons, so they get two
 * different treatments:
 *
 *   `%` `_`      SQL LIKE wildcards. Escaped with a backslash (PostgreSQL's
 *                default LIKE escape character) so they match literally. Leaving
 *                them raw would "work" for the snake_case case, since `_` also
 *                matches a literal underscore, but it over-matches: a search for
 *                `ai_flow_run_faile_` would happily return `ai_flow_run_failed`.
 *   `,` `(` `)`  PostgREST `or=(...)` logic-tree delimiters. An unescaped comma
 *                does not narrow the search, it makes the whole request fail
 *                with PGRST100. Handled by double-quoting the value, which
 *                PostgREST accepts for values containing reserved characters.
 *
 * The two interact, and the interaction is easy to get wrong: inside a
 * double-quoted PostgREST value the quote parser consumes one level of
 * backslash, so a LIKE escape must arrive as `\\_` to survive as `\_`. Written
 * with a single backslash the escape is silently eaten and the underscore goes
 * back to being a wildcard, with no error to notice. Hence the two passes below,
 * in this order.
 */
export function buildLogSearchFilter(search: string): string | null {
  const raw = search.trim();
  if (!raw) return null;
  // 1. LIKE-escape: make %, _ and backslash literal for the pattern engine.
  const likeSafe = raw.replace(/[\\%_]/g, (c) => `\\${c}`);
  // 2. PostgREST-quote-escape: backslash and double quote both need doubling
  //    inside a quoted value. This is what turns `\_` into the `\\_` the parser
  //    must see.
  const quoted = likeSafe.replace(/["\\]/g, (c) => `\\${c}`);
  return `event.ilike."%${quoted}%",message.ilike."%${quoted}%"`;
}

export type SystemLogInput = {
  businessId?: string | null;
  source: string;
  level: SystemLogLevel;
  event: string;
  message?: string;
  payload?: Record<string, unknown>;
};

/** Insert one log row. Throws on failure — prefer `recordSystemLog` at call sites. */
export async function insertSystemLog(
  input: SystemLogInput,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("system_logs").insert({
    business_id: input.businessId ?? null,
    source: input.source,
    level: input.level,
    event: input.event,
    message: (input.message ?? "").slice(0, 4000),
    payload: input.payload ?? {}
  });
  if (error) throw new Error(`insertSystemLog: ${error.message}`);
}

/**
 * Fire-and-forget insert that also mirrors to the console logger. Never
 * throws and never rejects, so it is safe in any hot path / catch block.
 */
export async function recordSystemLog(
  input: SystemLogInput,
  client?: SupabaseClient
): Promise<void> {
  const consoleCtx = {
    businessId: input.businessId ?? undefined,
    source: input.source,
    event: input.event,
    ...input.payload
  };
  logger[input.level](input.message ?? input.event, consoleCtx);
  try {
    await insertSystemLog(input, client);
  } catch (e) {
    logger.warn("recordSystemLog: persist failed", {
      event: input.event,
      error: e instanceof Error ? e.message : String(e)
    });
  }
}

export type ListSystemLogsOptions = {
  level?: SystemLogLevel;
  /** Include this level and everything more severe (e.g. "warn" → warn+error). */
  minLevel?: SystemLogLevel;
  source?: string;
  /** Substring match against event + message. */
  search?: string;
  /** Only rows strictly older than this ISO timestamp (keyset pagination). */
  before?: string;
  limit?: number;
};

const LEVEL_ORDER: SystemLogLevel[] = ["debug", "info", "warn", "error"];

function levelsAtOrAbove(min: SystemLogLevel): SystemLogLevel[] {
  return LEVEL_ORDER.slice(LEVEL_ORDER.indexOf(min));
}

/** Newest-first logs for one business. */
export async function listSystemLogs(
  businessId: string,
  options: ListSystemLogsOptions = {},
  client?: SupabaseClient
): Promise<SystemLogRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  let q = db.from("system_logs").select(LOG_COLS).eq("business_id", businessId);
  if (options.level) {
    q = q.eq("level", options.level);
  } else if (options.minLevel && options.minLevel !== "debug") {
    q = q.in("level", levelsAtOrAbove(options.minLevel));
  }
  if (options.source) q = q.eq("source", options.source);
  if (options.search) {
    const filter = buildLogSearchFilter(options.search);
    if (filter) {
      q = q.or(filter);
    }
  }
  if (options.before) q = q.lt("created_at", options.before);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(Math.max(1, Math.min(options.limit ?? 100, 500)));
  if (error) throw new Error(`listSystemLogs: ${error.message}`);
  return (data ?? []) as SystemLogRow[];
}

export type SystemLogWithBusiness = SystemLogRow & {
  businesses: { name: string } | null;
};

/** Fleet-wide newest-first error feed (admin dashboard). */
export async function listSystemLogErrorsAll(
  limit = 30,
  client?: SupabaseClient,
  options?: {
    /**
     * Businesses hidden from the feed (admin notification mutes — see
     * src/lib/db/admin-mutes.ts). Platform rows (business_id null) always
     * stay: a bare NOT IN would drop them because `NULL NOT IN (...)` is
     * never true in SQL, hence the explicit is-null arm.
     */
    excludeBusinessIds?: string[];
  }
): Promise<SystemLogWithBusiness[]> {
  const db = client ?? (await createSupabaseServiceClient());
  let q = db
    .from("system_logs")
    .select(`${LOG_COLS},businesses(name)`)
    .eq("level", "error");
  const excluded = options?.excludeBusinessIds ?? [];
  if (excluded.length > 0) {
    q = q.or(`business_id.is.null,business_id.not.in.(${excluded.join(",")})`);
  }
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 200)));
  if (error) throw new Error(`listSystemLogErrorsAll: ${error.message}`);
  return (data ?? []) as unknown as SystemLogWithBusiness[];
}
