/**
 * Supabase Edge Function: contract-term-nudge-sweep
 *
 * Cron bridge for the daily pre-term contract rollover nudge.
 * pg_cron hits this with `Authorization: Bearer <INTERNAL_CRON_SECRET>`;
 * we validate the bearer, then forward to the Next.js internal endpoint
 * which holds the sweep logic (Resend + catalog need the Node runtime),
 * same indirection as monthly-intro-nudge-sweep.
 *
 * Environment:
 *   INTERNAL_CRON_SECRET    (required), shared with cron and Next.js app
 *   NEXT_PUBLIC_APP_URL     (required), base URL of the Next.js deployment
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { assertCronAuth } from "../_shared/cron_auth.ts";

const TARGET_PATH = "/api/internal/contract-term-nudge-sweep";
const REQUEST_TIMEOUT_MS = 290_000;

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!(await assertCronAuth(req))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const appUrl = (Deno.env.get("NEXT_PUBLIC_APP_URL") ?? "").trim();
  const cronSecret = (Deno.env.get("INTERNAL_CRON_SECRET") ?? "").trim();
  if (!appUrl || !cronSecret) {
    return json(
      {
        ok: false,
        error: "server_misconfigured",
        missing: { appUrl: !appUrl, cronSecret: !cronSecret }
      },
      500
    );
  }

  const target = new URL(TARGET_PATH, appUrl).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cronSecret}`,
        // Attribution for public.cron_sweep_runs: marks this run as
        // pg_cron-driven, so a route that also accepts the same bearer from
        // elsewhere cannot mask a dead cron job. See src/lib/cron/sweep-run.ts.
        "X-Cron-Job": "contract-term-nudge-sweep",
        // CSRF gate: src/proxy.ts allows server-to-server bearer POSTs only
        // when Origin matches NEXT_PUBLIC_APP_URL.
        Origin: appUrl
      },
      body: "{}",
      signal: controller.signal
    });
    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "application/json";
    return new Response(text, {
      status: res.status,
      headers: { "Content-Type": contentType }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("contract-term-nudge-sweep bridge failure", { target, message });
    return json({ ok: false, error: "bridge_failure" }, 502);
  } finally {
    clearTimeout(timeout);
  }
});

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
