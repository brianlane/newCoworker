/**
 * How did the cron-driven HTTP chains actually behave? Reads the LIVE
 * net._http_response table (pg_net's response log, retained ~6h) and prints
 * per-route stats: volume, status codes, pg_net timeouts, and the route's own
 * durationMs (p50/p95/max).
 *
 * Why this table: pg_net's http_post is asynchronous, so a pg_cron run only
 * ENQUEUES the request and cron.job_run_details never sees the outcome. A
 * timeout against timeout_milliseconds or the 150s Edge ceiling shows up
 * here, as timed_out=true or a 504, and nowhere else.
 *
 * Attribution: the table has no job column, so rows are grouped by the JSON
 * shape the route returned (sorted key set, durationMs excluded). Each sweep's
 * body is distinctive, e.g. {claimed,deferred,ok,processed,stranded} is
 * sms-inbound-worker.
 *
 * The window is ~6 hours, so a single run misses most daily sweeps. Run it a
 * few times across a day (e.g. after the 02:50 analytics wave and the 11:10
 * platform-cost-sync) to cover the heavies in KNOWN_ABOVE_EDGE_CEILING.
 *
 * Usage:
 *   tsx debug/cron-http-stats.ts [--json]
 *
 * Read-only: the session is opened default_transaction_read_only=on.
 */
import { Client } from "pg";
import { loadEnv, sessionDbUrl } from "./_shared.ts";
import {
  summarizeResponses,
  type HttpResponseRow
} from "../src/lib/cron/sweep-http-stats.ts";

loadEnv();

const AS_JSON = process.argv.includes("--json");

async function main(): Promise<void> {
  // Session connection, sslmode stripped, transaction pooler refused: the
  // read-only guard below is a session setting the transaction pooler drops
  // without telling anyone. See sessionDbUrl in _shared.ts.
  const url = sessionDbUrl();

  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
    options: "-c default_transaction_read_only=on"
  });
  await client.connect();
  try {
    const res = await client.query<{
      status_code: number | null;
      timed_out: boolean | null;
      error_msg: string | null;
      content_type: string | null;
      content: string | null;
      created: Date;
    }>(
      "select status_code, timed_out, error_msg, content_type, content, created from net._http_response"
    );
    const rows: HttpResponseRow[] = res.rows.map((r) => ({
      statusCode: r.status_code ?? 0,
      timedOut: r.timed_out ?? false,
      errorMsg: r.error_msg,
      contentType: r.content_type,
      content: r.content,
      created: r.created
    }));
    const report = summarizeResponses(rows);

    if (AS_JSON) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (report.window) {
        console.log(
          `window: ${report.window.oldest.toISOString()} .. ${report.window.newest.toISOString()}  (${report.total} responses, ${report.timedOut} timed out, ${report.errored} errored)\n`
        );
      } else {
        console.log("no responses in retention window\n");
      }
      const fmt = (v: number | null) => (v === null ? "-" : `${(v / 1000).toFixed(1)}s`);
      for (const g of report.groups) {
        const bad =
          g.timedOut > 0 || g.http5xx > 0 || g.errored > 0
            ? `  <-- timedOut=${g.timedOut} 5xx=${g.http5xx} errored=${g.errored}`
            : "";
        console.log(
          `n=${String(g.n).padStart(5)}  p50=${fmt(g.durations.p50Ms).padStart(7)}  p95=${fmt(g.durations.p95Ms).padStart(7)}  max=${fmt(g.durations.maxMs).padStart(7)}  ${g.signature}${bad}`
        );
      }
    }
    if (report.timedOut > 0 || report.errored > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
