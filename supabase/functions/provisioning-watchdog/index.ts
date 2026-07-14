/**
 * Supabase Edge Function: provisioning-watchdog
 *
 * Cron bridge for the signup-provisioning retry sweep.
 *
 * pg_cron hits this Edge function every 5 minutes with
 *   Authorization: Bearer <INTERNAL_CRON_SECRET>.
 * We validate the bearer, then forward to the Next.js internal endpoint
 * which claims + re-runs one stalled provisioning job — same indirection
 * as the vps-billing-posture bridge so the orchestrator logic stays in
 * one Node runtime.
 *
 * Environment:
 *   INTERNAL_CRON_SECRET    (required) — shared with cron and Next.js app
 *   NEXT_PUBLIC_APP_URL     (required) — base URL of the Next.js deployment
 *
 * Response: forwards the Next.js body and status. On any bridge-level
 * failure returns 502 so the pg_cron audit log captures something useful.
 * The forward timeout is shorter than a full provision on purpose — an
 * abort here is harmless because the Next route runs to completion.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { assertCronAuth } from "../_shared/cron_auth.ts";

const TARGET_PATH = "/api/internal/provisioning-retry";
const REQUEST_TIMEOUT_MS = 280_000;

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
        // CSRF gate: src/proxy.ts allows server-to-server bearer POSTs only
        // when Origin matches NEXT_PUBLIC_APP_URL. Set it explicitly so the
        // bearer check (not Origin) is the actual auth boundary.
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
    console.error("provisioning-watchdog bridge failure", { target, message });
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
