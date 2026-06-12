import { NextResponse } from "next/server";
import { updateNotificationPreferences } from "@/lib/db/notification-preferences";
import { logger } from "@/lib/logger";

/**
 * Unauthenticated one-click unsubscribe endpoint linked from operator emails.
 *
 * GET  → human-friendly HTML confirmation page (clicked from an email).
 * POST → RFC 8058 List-Unsubscribe-Post target. Mail clients (Gmail, Apple
 *        Mail, Outlook iOS) hit this with `List-Unsubscribe=One-Click` in the
 *        body when the user taps the native "Unsubscribe" UI. Plain 200 text
 *        response is what they expect.
 *
 * The endpoint identifies the business via the `bid` query/form parameter,
 * which is the business UUID. UUID v4 has 122 bits of entropy and isn't
 * brute-forceable; if a particular UUID ever leaks (logs, support tickets,
 * forwarded email, etc.) the worst an attacker can do is unsubscribe that
 * one business — a flag the owner can re-enable in the dashboard with one
 * click. That tradeoff matches what most mainstream ESPs ship.
 *
 * Both shapes are idempotent: re-hitting the endpoint with the same `bid`
 * just re-asserts the same state.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ApplyResult = "ok" | "invalid" | "error";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function applyUnsubscribe(bid: string | null): Promise<ApplyResult> {
  if (!bid || !UUID_RE.test(bid)) return "invalid";

  try {
    await updateNotificationPreferences(bid, {
      sms_urgent: false,
      email_digest: false,
      email_digest_weekly: false,
      email_urgent: false,
      dashboard_alerts: false,
      unsubscribed_at: new Date().toISOString()
    });
    return "ok";
  } catch (err) {
    logger.warn("unsubscribe: update failed", {
      businessId: bid,
      error: err instanceof Error ? err.message : String(err)
    });
    return "error";
  }
}

function htmlPage(title: string, body: string, status: number): NextResponse {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0d0f12; color: #e9e6dc; margin: 0; padding: 48px 16px; }
    .card { max-width: 480px; margin: 0 auto; background: #14181d; border: 1px solid rgba(233,230,220,0.1); border-radius: 12px; padding: 32px; }
    h1 { font-size: 1.25rem; margin: 0 0 12px; }
    p { line-height: 1.5; color: rgba(233,230,220,0.7); margin: 0 0 16px; }
    a { color: #4dd0e1; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    ${body}
  </div>
</body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "https://www.newcoworker.com").replace(/\/$/, "");
}

export async function GET(request: Request) {
  const bid = new URL(request.url).searchParams.get("bid");
  const result = await applyUnsubscribe(bid);

  if (result === "ok") {
    return htmlPage(
      "You've been unsubscribed",
      `<p>We won't send you any more email or SMS notifications.</p>
       <p>Changed your mind? <a href="${appUrl()}/dashboard/notifications">Re-subscribe in your dashboard</a>.</p>`,
      200
    );
  }
  if (result === "error") {
    return htmlPage(
      "Something went wrong",
      `<p>We couldn't update your preferences just now. Please try again or <a href="${appUrl()}/dashboard/notifications">unsubscribe in the dashboard</a>.</p>`,
      500
    );
  }
  return htmlPage(
    "Invalid link",
    `<p>This unsubscribe link is missing or invalid. Please <a href="${appUrl()}/dashboard/notifications">manage your preferences in the dashboard</a>.</p>`,
    400
  );
}

export async function POST(request: Request) {
  // RFC 8058 one-click flow: bid may come from the query string or the
  // `List-Unsubscribe-Post` form body. Accept both.
  let bid = new URL(request.url).searchParams.get("bid");
  if (!bid) {
    try {
      const ct = request.headers.get("content-type") ?? "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        const body = await request.text();
        const params = new URLSearchParams(body);
        bid = params.get("bid");
      }
    } catch {
      // If body parsing throws, fall through to the "no bid" branch.
    }
  }

  const result = await applyUnsubscribe(bid);
  const ok = result === "ok";
  // Mail clients ignore HTML for the POST flow; reply with bare text.
  return new NextResponse(ok ? "Unsubscribed" : `Failed: ${result}`, {
    status: ok ? 200 : result === "error" ? 500 : 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
