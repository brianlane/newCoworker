import { NextResponse } from "next/server";
import { updateNotificationPreferences } from "@/lib/db/notification-preferences";
import { allChannelTogglesOff } from "@/lib/notifications/channel-toggles";
import { logger } from "@/lib/logger";
import { SITE_URL } from "@/lib/marketing/site-url";
// The bid is UUID-validated before it reaches the form, so this is a second
// line rather than the only one. Reuse the shared escaper regardless: a
// hand-built page interpolating a query parameter should never be the place
// someone has to reason about that.
import { escapeHtml } from "@/lib/email/branded-html";

/**
 * Unauthenticated one-click unsubscribe endpoint linked from operator emails.
 *
 * GET  → asks. Renders a confirmation page whose button POSTs back here.
 *        It does NOT write, and that is the point: a GET that unsubscribed
 *        on sight meant any corporate mail scanner, security sandbox, or
 *        link prefetcher that follows links in a message could switch off
 *        email, SMS, WhatsApp, dashboard, and warm-transfer alerts for a
 *        business, with nobody told it had happened. Following a link is
 *        not a decision; pressing the button is.
 * POST → the write. Two callers, one handler:
 *        - RFC 8058 List-Unsubscribe-Post. Mail clients (Gmail, Apple Mail,
 *          Outlook iOS) hit this with `List-Unsubscribe=One-Click` in the
 *          body when the user taps the native "Unsubscribe" UI. They expect
 *          a plain 200. This path is a real user action in the client's own
 *          UI, so acting immediately is correct.
 *        - the confirmation page's form, which sends `ui=1` and gets a
 *          rendered page back instead of one bare word.
 *
 * The endpoint identifies the business via the `bid` query/form parameter,
 * which is the business UUID. UUID v4 has 122 bits of entropy and isn't
 * brute-forceable; if a particular UUID ever leaks (logs, support tickets,
 * forwarded email, etc.) the worst an attacker can do is unsubscribe that
 * one business, a flag the owner can re-enable in the dashboard with one
 * click. That tradeoff matches what most mainstream ESPs ship.
 *
 * Both shapes are idempotent: re-hitting the endpoint with the same `bid`
 * just re-asserts the same state.
 *
 * SCOPES. `scope=monthly_recap` turns off ONE email and nothing else. A
 * recurring email needs an opt-out proportionate to itself: the footer of the
 * monthly recap pointing here unscoped would have let someone who merely did
 * not want a summary switch off urgent lead alerts on every channel, which
 * they would discover only by missing a lead. Anything else, including a
 * missing or unrecognized scope, is the full unsubscribe (the mail-client
 * one-click header carries no scope, and for that gesture "all" is right).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ApplyResult = "ok" | "invalid" | "error";

/** The one narrow scope; everything else means "all". */
const MONTHLY_RECAP_SCOPE = "monthly_recap";

export type UnsubscribeScope = "all" | "monthly_recap";

/** Unrecognized, absent, or malformed input all resolve to the full opt-out. */
export function resolveScope(raw: string | null): UnsubscribeScope {
  return raw === MONTHLY_RECAP_SCOPE ? "monthly_recap" : "all";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function applyUnsubscribe(
  bid: string | null,
  scope: UnsubscribeScope = "all"
): Promise<ApplyResult> {
  if (!bid || !UUID_RE.test(bid)) return "invalid";

  if (scope === "monthly_recap") {
    try {
      // One flag, and deliberately NOT `unsubscribed_at`: this person still
      // wants their alerts, so marking the business globally unsubscribed
      // would both stop those and render every toggle off in the dashboard.
      await updateNotificationPreferences(bid, { email_monthly_recap: false });
      return "ok";
    } catch (err) {
      logger.warn("unsubscribe: monthly recap update failed", {
        businessId: bid,
        error: err instanceof Error ? err.message : String(err)
      });
      return "error";
    }
  }

  try {
    // Every channel toggle, from the one list the dashboard's "Unsubscribe
    // from all" button also builds its payload from. Hand-listing them here
    // is what left whatsapp_urgent, then push_urgent, then all five chat
    // channels rendering ON underneath the "you unsubscribed" banner.
    await updateNotificationPreferences(bid, {
      ...allChannelTogglesOff(),
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
  return (process.env.NEXT_PUBLIC_APP_URL ?? SITE_URL).replace(/\/$/, "");
}

/** The page the GET renders: what will happen, and a button that does it. */
function confirmPage(bid: string, scope: UnsubscribeScope): NextResponse {
  const isRecap = scope === "monthly_recap";
  return htmlPage(
    isRecap ? "Stop the monthly recap?" : "Unsubscribe from New Coworker alerts?",
    `<p>${
      isRecap
        ? `This turns off the monthly recap email only. Your urgent alerts,
      digests and dashboard notifications all keep working.`
        : `This turns off every notification for this business: urgent alerts
      by email, text, WhatsApp, Slack, Telegram, Microsoft Teams, Google Chat
      and push, the daily, weekly and monthly summaries, dashboard alerts,
      and warm-transfer texts.`
    }</p>
     <form method="post" action="/api/notifications/unsubscribe">
       <input type="hidden" name="bid" value="${escapeHtml(bid)}" />
       <input type="hidden" name="ui" value="1" />
       ${isRecap ? `<input type="hidden" name="scope" value="${MONTHLY_RECAP_SCOPE}" />` : ""}
       <button type="submit" style="background:#2EC4B6;color:#0d0f12;border:0;border-radius:8px;padding:12px 20px;font-size:15px;font-weight:600;cursor:pointer;">${
         isRecap ? "Yes, stop the recap" : "Yes, unsubscribe"
       }</button>
     </form>
     <p style="margin-top:16px;">Or <a href="${appUrl()}/dashboard/notifications">choose which alerts to keep</a>.</p>`,
    200
  );
}

function invalidPage(): NextResponse {
  return htmlPage(
    "Invalid link",
    `<p>This unsubscribe link is missing or invalid. Please <a href="${appUrl()}/dashboard/notifications">manage your preferences in the dashboard</a>.</p>`,
    400
  );
}

function donePage(result: ApplyResult, scope: UnsubscribeScope): NextResponse {
  if (result === "ok" && scope === "monthly_recap") {
    return htmlPage(
      "Monthly recap turned off",
      `<p>That was the only thing this changed. Your alerts and digests are untouched.</p>
       <p>Changed your mind? <a href="${appUrl()}/dashboard/notifications">Turn it back on in your dashboard</a>.</p>`,
      200
    );
  }
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
  return invalidPage();
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const bid = url.searchParams.get("bid");
  // Deliberately no write here. Validate the link and ask.
  if (!bid || !UUID_RE.test(bid)) return invalidPage();
  return confirmPage(bid, resolveScope(url.searchParams.get("scope")));
}

export async function POST(request: Request) {
  // RFC 8058 one-click flow: bid may come from the query string or the
  // `List-Unsubscribe-Post` form body. Accept both. `ui=1` marks the
  // confirmation page's own form, which wants a page back.
  const url = new URL(request.url);
  let bid = url.searchParams.get("bid");
  let fromConfirmPage = url.searchParams.get("ui") === "1";
  let rawScope = url.searchParams.get("scope");
  if (!bid || !fromConfirmPage || !rawScope) {
    try {
      const ct = request.headers.get("content-type") ?? "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        const body = await request.text();
        const params = new URLSearchParams(body);
        bid = bid ?? params.get("bid");
        fromConfirmPage = fromConfirmPage || params.get("ui") === "1";
        rawScope = rawScope ?? params.get("scope");
      }
    } catch {
      // If body parsing throws, fall through to the "no bid" branch.
    }
  }

  const scope = resolveScope(rawScope);
  const result = await applyUnsubscribe(bid, scope);
  // A person who just pressed a button gets a page; a mail client that
  // ignores HTML entirely gets the bare text it expects.
  if (fromConfirmPage) return donePage(result, scope);

  const ok = result === "ok";
  return new NextResponse(ok ? "Unsubscribed" : `Failed: ${result}`, {
    status: ok ? 200 : result === "error" ? 500 : 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
