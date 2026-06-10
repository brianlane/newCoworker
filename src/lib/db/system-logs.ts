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
    const escaped = options.search.replace(/[%_,()]/g, "");
    if (escaped) {
      q = q.or(`event.ilike.%${escaped}%,message.ilike.%${escaped}%`);
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
  client?: SupabaseClient
): Promise<SystemLogWithBusiness[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("system_logs")
    .select(`${LOG_COLS},businesses(name)`)
    .eq("level", "error")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 200)));
  if (error) throw new Error(`listSystemLogErrorsAll: ${error.message}`);
  return (data ?? []) as unknown as SystemLogWithBusiness[];
}
