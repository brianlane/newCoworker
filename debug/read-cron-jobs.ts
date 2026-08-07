/**
 * Read the LIVE pg_cron jobs and diff them against what the migrations say.
 *
 * Every cron timeout fix in this repo ships as a migration and is "verified"
 * by the push-to-main CI run going green. That proves the migration ran; it
 * does not prove the live `cron.job` rows now carry the new numbers (a
 * cron.unschedule guard that silently matched nothing, a job renamed out from
 * under a migration, or hand-edits via the dashboard all leave CI green and
 * production stale). This script closes that gap: it connects straight to
 * Postgres, reads `cron.job`, and compares each job's schedule and
 * timeout_milliseconds against the repo's effective values (last
 * cron.schedule definition per jobname across sorted migrations, same parse
 * as tests/cron-timeout-parity.test.ts).
 *
 * Strictly read-only: the session is opened with
 * default_transaction_read_only=on, so a stray write would error rather than
 * run.
 *
 * Usage:
 *   tsx debug/read-cron-jobs.ts            # diff, exit 1 on any drift
 *   tsx debug/read-cron-jobs.ts --json     # machine-readable dump, same exit
 *
 * Connects via DIRECT_DATABASE_URL, the SESSION pooler on port 5432. It falls
 * back to DATABASE_URL only when that is also a session connection: the
 * transaction pooler (6543) drops the read-only session setting above without
 * reporting anything, so accepting it would hand a writable session to a
 * script that advertises itself as read-only. See sessionDbUrl in _shared.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { loadEnv, sessionDbUrl } from "./_shared.ts";

loadEnv();

const AS_JSON = process.argv.includes("--json");

type JobNumbers = {
  schedule: string | null;
  timeoutMs: number | null;
  fn: string | null;
};

function parseCommand(command: string): Omit<JobNumbers, "schedule"> {
  return {
    timeoutMs: command.match(/timeout_milliseconds\s*:=\s*(\d+)/)?.[1]
      ? Number(command.match(/timeout_milliseconds\s*:=\s*(\d+)/)![1])
      : null,
    fn: command.match(/\/functions\/v1\/([A-Za-z0-9_-]+)/)?.[1] ?? null
  };
}

/**
 * Repo-side truth: replay every cron.schedule AND cron.unschedule in
 * migration apply order (files sorted, calls in document order within a
 * file). Tracking only schedules gets the common re-schedule pattern right
 * but misreads a deliberate unschedule-ONLY migration
 * (20260812000200_unschedule_residency_replay.sql) as "missing from live".
 */
function repoJobs(): Map<string, JobNumbers> {
  const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "supabase", "migrations");
  const out = new Map<string, JobNumbers>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    for (const m of sql.matchAll(/cron\.(schedule|unschedule)\s*\(\s*'([^']+)'/g)) {
      const [, kind, name] = m;
      if (kind === "unschedule") {
        out.delete(name);
        continue;
      }
      const block = sql.slice(m.index).split(/cron\.schedule\s*\(/)[1] ?? "";
      const schedule = block.match(/^\s*'[^']+'\s*,\s*'([^']+)'/)?.[1] ?? null;
      const parsed = parseCommand(block);
      const prev = out.get(name);
      out.set(name, {
        schedule: schedule ?? prev?.schedule ?? null,
        timeoutMs: parsed.timeoutMs ?? prev?.timeoutMs ?? null,
        fn: parsed.fn ?? prev?.fn ?? null
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  // Session connection, sslmode stripped, transaction pooler refused: the
  // read-only guard below is a session setting the transaction pooler drops
  // without telling anyone. See sessionDbUrl in _shared.ts.
  const url = sessionDbUrl();

  const client = new Client({
    connectionString: url,
    // Supabase terminates TLS with a cert the local trust store rejects.
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
    // Belt and braces for a reader: any write in this session errors.
    options: "-c default_transaction_read_only=on"
  });
  await client.connect();
  try {
    const live = await client.query<{
      jobname: string;
      schedule: string;
      command: string;
      active: boolean;
    }>("select jobname, schedule, command, active from cron.job order by jobname");

    // The RPC #1164 shipped; a null here means the migration did not land.
    const rpc = await client.query<{ reg: string | null }>(
      "select to_regprocedure('public.release_sms_inbound_jobs(uuid[])')::text as reg"
    );

    const expected = repoJobs();
    const problems: string[] = [];
    const rows: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();

    for (const job of live.rows) {
      seen.add(job.jobname);
      const parsed = parseCommand(job.command);
      const want = expected.get(job.jobname);
      const drift: string[] = [];
      if (!job.active) drift.push("INACTIVE");
      if (!want) {
        drift.push("not defined in any migration");
      } else {
        if (want.timeoutMs !== null && parsed.timeoutMs !== want.timeoutMs) {
          drift.push(`timeout live=${parsed.timeoutMs} repo=${want.timeoutMs}`);
        }
        if (want.schedule !== null && job.schedule !== want.schedule) {
          drift.push(`schedule live='${job.schedule}' repo='${want.schedule}'`);
        }
      }
      rows.push({
        job: job.jobname,
        schedule: job.schedule,
        timeoutMs: parsed.timeoutMs,
        fn: parsed.fn,
        active: job.active,
        drift
      });
      if (drift.length > 0) problems.push(`${job.jobname}: ${drift.join("; ")}`);
    }

    for (const [name] of expected) {
      if (!seen.has(name)) problems.push(`${name}: in migrations but MISSING from live cron.job`);
    }
    if (rpc.rows[0]?.reg === null) {
      problems.push("release_sms_inbound_jobs(uuid[]): MISSING in production");
    }

    if (AS_JSON) {
      console.log(JSON.stringify({ rows, rpcPresent: rpc.rows[0]?.reg !== null, problems }, null, 2));
    } else {
      const w = Math.max(...rows.map((r) => String(r.job).length));
      for (const r of rows) {
        const flag = (r.drift as string[]).length > 0 ? "  <-- " + (r.drift as string[]).join("; ") : "";
        console.log(
          `${String(r.job).padEnd(w)}  ${String(r.schedule).padEnd(12)}  timeout=${String(r.timeoutMs).padEnd(8)}  active=${r.active}${flag}`
        );
      }
      console.log(`\nrelease_sms_inbound_jobs(uuid[]) present: ${rpc.rows[0]?.reg !== null}`);
      console.log(
        problems.length === 0
          ? `\nOK: all ${rows.length} live jobs match the migrations.`
          : `\nDRIFT (${problems.length}):\n- ${problems.join("\n- ")}`
      );
    }
    if (problems.length > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
