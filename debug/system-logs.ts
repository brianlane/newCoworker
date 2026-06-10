/**
 * system-logs.ts — tail/filter the unified `system_logs` table from the CLI.
 *
 * The same data the admin business page's "System Logs" card shows: every
 * component serving a client's AI (ai-flow-worker, chat-worker, sms/voice
 * Edge functions, the app) writes structured rows here, so "the client ran
 * an AI and it didn't work" is answerable without SSH.
 *
 *   tsx debug/system-logs.ts                                # latest 50, fleet-wide
 *   tsx debug/system-logs.ts <businessId>                   # one tenant
 *   tsx debug/system-logs.ts <businessId> --level=error     # errors only
 *   tsx debug/system-logs.ts --min-level=warn               # warn + error
 *   tsx debug/system-logs.ts --source=aiflow --grep=telnyx  # filter source + text
 *   tsx debug/system-logs.ts --since=2h --limit=200         # time window (m/h/d)
 *   tsx debug/system-logs.ts <businessId> --follow          # poll for new rows (5s)
 *   tsx debug/system-logs.ts --json                         # raw JSON lines
 *
 * Read-only. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env`.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env)");
  process.exit(1);
}

type LogRow = {
  id: number;
  business_id: string | null;
  source: string;
  level: string;
  event: string;
  message: string;
  payload: Record<string, unknown>;
  created_at: string;
};

const LEVELS = ["debug", "info", "warn", "error"] as const;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const businessId = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const level = arg("level");
const minLevel = arg("min-level");
const source = arg("source");
const grep = arg("grep");
const limit = Math.max(1, Math.min(Number(arg("limit") ?? "50"), 1000));
const follow = flag("follow");
const asJson = flag("json");

if (level && !LEVELS.includes(level as (typeof LEVELS)[number])) {
  console.error(`--level must be one of: ${LEVELS.join(", ")}`);
  process.exit(1);
}

/** "90m" / "2h" / "7d" → ISO timestamp that long ago. */
function sinceToIso(raw: string): string {
  const m = /^(\d+)([mhd])$/.exec(raw.trim());
  if (!m) {
    console.error(`--since must look like 30m, 2h or 7d (got "${raw}")`);
    process.exit(1);
  }
  const n = Number(m[1]);
  const ms = m[2] === "m" ? n * 60_000 : m[2] === "h" ? n * 3_600_000 : n * 86_400_000;
  return new Date(Date.now() - ms).toISOString();
}
const sinceIso = arg("since") ? sinceToIso(arg("since")!) : null;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function fetchRows(afterId: number | null): Promise<LogRow[]> {
  let q = sb
    .from("system_logs")
    .select("id,business_id,source,level,event,message,payload,created_at");
  if (businessId) q = q.eq("business_id", businessId);
  if (level) q = q.eq("level", level);
  else if (minLevel) {
    const idx = LEVELS.indexOf(minLevel as (typeof LEVELS)[number]);
    if (idx > 0) q = q.in("level", [...LEVELS.slice(idx)]);
  }
  if (source) q = q.eq("source", source);
  if (grep) {
    const safe = grep.replace(/[%_,()]/g, "");
    if (safe) q = q.or(`event.ilike.%${safe}%,message.ilike.%${safe}%`);
  }
  if (sinceIso) q = q.gte("created_at", sinceIso);
  if (afterId !== null) q = q.gt("id", afterId);
  const { data, error } = await q.order("id", { ascending: false }).limit(limit);
  if (error) {
    console.error(`query failed: ${error.message}`);
    process.exit(1);
  }
  return ((data ?? []) as LogRow[]).reverse(); // print oldest-first
}

const COLOR: Record<string, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m"
};
const RESET = "\x1b[0m";

function printRow(r: LogRow): void {
  if (asJson) {
    console.log(JSON.stringify(r));
    return;
  }
  const c = COLOR[r.level] ?? "";
  const biz = businessId ? "" : ` ${r.business_id ? r.business_id.slice(0, 8) : "platform"}`;
  const msg = r.message && r.message !== r.event ? ` — ${r.message}` : "";
  const extras = Object.keys(r.payload ?? {}).length
    ? ` ${JSON.stringify(r.payload)}`
    : "";
  console.log(
    `${r.created_at}${biz} ${c}${r.level.toUpperCase().padEnd(5)}${RESET} [${r.source}] ${r.event}${msg}${extras}`
  );
}

async function main(): Promise<void> {
  let rows = await fetchRows(null);
  rows.forEach(printRow);
  if (!follow) return;

  let lastId = rows.at(-1)?.id ?? 0;
  console.error(`-- following (poll 5s), Ctrl-C to stop --`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    rows = await fetchRows(lastId);
    rows.forEach(printRow);
    if (rows.length > 0) lastId = rows.at(-1)!.id;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
