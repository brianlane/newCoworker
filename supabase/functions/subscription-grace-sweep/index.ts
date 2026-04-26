/**
 * Supabase Edge Function: subscription-grace-sweep
 *
 * Daily cron bridge for the subscription lifecycle wipe path.
 *
 * pg_cron hits this Edge function with
 *   Authorization: Bearer <INTERNAL_CRON_SECRET>.
 * We validate the bearer, then forward the call to the Next.js internal
 * endpoint which does the actual Stripe/Hostinger/Supabase work — keeping
 * all heavy lifecycle logic in one place (Node runtime) instead of
 * duplicating it into Deno.
 *
 * Environment:
 *   INTERNAL_CRON_SECRET    (required) — shared with cron and Next.js app
 *   NEXT_PUBLIC_APP_URL     (required) — base URL of the Next.js deployment
 *
 * Response: forwards the Next.js body and status. On any bridge-level
 * failure (missing env, network error, non-2xx from the app) returns 502
 * with a short error payload so pg_cron's `net.http_post` logs a useful
 * reason.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { assertCronAuth } from "../_shared/cron_auth.ts";

const TARGET_PATH = "/api/internal/subscription-grace-sweep";
const REQUEST_TIMEOUT_MS = 120_000;

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
        missing: {
          appUrl: !appUrl,
          cronSecret: !cronSecret
        }
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
        Authorization: `Bearer ${cronSecret}`
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
    console.error("subscription-grace-sweep bridge failure", { target, message });
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
