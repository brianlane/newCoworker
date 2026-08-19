/**
 * One way for a background sweep to reach a human.
 *
 * WHY THIS EXISTS. Two alert paths believed they paged someone and did not.
 * `voice-bridge-health-alerts` posts only to `ALERT_WEBHOOK_URL`, which has
 * never been set in this project, so its every-5-minute check that each
 * tenant's voice bridge is alive has only ever written rows nobody reads. A
 * dead bridge means that client's calls are failing right now. The
 * call-integrity sweep then copied the same borrowed mistake.
 *
 * Email is what the platform actually uses. `chat-spend-velocity-alerts`,
 * `voice-capacity-monitor` and `notifications-digest` each resolve the same
 * three env vars and POST to Resend, and every one of those vars is already
 * configured in production. So this is that pattern extracted ONCE rather
 * than hand-copied a fourth and fifth time. Copying it is what produces the
 * drift this codebase keeps getting bitten by.
 *
 * The three existing callers are deliberately left alone: they work, they are
 * live alerting paths, and rewiring them buys nothing a reader can see. New
 * callers should use this.
 *
 * Pure except for the injected fetch, so it pins at 100% coverage like every
 * other `_shared` module.
 */

/** Reads one environment variable. Injected so the resolver stays testable. */
export type AdminAlertEnv = (name: string) => string | undefined;

/** Minimal fetch shape, injected so the transport is testable. */
export type AdminAlertFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export type AdminAlertConfig = { to: string; from: string; resendKey: string };

/** Used when MAILER_EMAIL is unset, matching the sibling alert paths. */
const DEFAULT_FROM = "New Coworker <contact@newcoworker.com>";

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

/**
 * Where an admin alert goes, or null when this deployment cannot send one.
 *
 * Recipient precedence matches the three existing callers exactly, so an
 * operator who sets `ADMIN_ALERT_EMAIL` to split alerts from ordinary mail
 * gets the same behavior everywhere.
 *
 * Returning null rather than a half-filled config is the point: an alerter
 * that silently no-ops is precisely the bug this module was written for, so
 * "cannot send" is a value every caller is forced to handle.
 */
export function resolveAdminAlertConfig(env: AdminAlertEnv): AdminAlertConfig | null {
  const resendKey = clean(env("RESEND_API_KEY"));
  const to =
    clean(env("ADMIN_ALERT_EMAIL")) || clean(env("ADMIN_EMAIL")) || clean(env("CONTACT_EMAIL"));
  if (!resendKey || !to) return null;
  return { to, from: clean(env("MAILER_EMAIL")) || DEFAULT_FROM, resendKey };
}

/**
 * Has enough time passed since the last alert of this kind?
 *
 * The flood guard. `voice-bridge-health-alerts` re-detects the same stale
 * bridge every 5 minutes, so without a window it would send twelve emails an
 * hour until someone muted the thread, and a muted alert is the same as no
 * alert at all.
 *
 * An unparseable stamp sends. A stored value we cannot read is a broken
 * bookkeeping row, and the cost of one extra email is far below the cost of
 * going quiet about a tenant whose calls are failing.
 */
export function shouldSendAdminAlert(
  lastSentAtIso: string | null,
  nowMs: number,
  throttleMinutes: number
): boolean {
  if (!lastSentAtIso) return true;
  const last = Date.parse(lastSentAtIso);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= throttleMinutes * 60_000;
}

export type AdminAlertResult = "sent" | "post_failed";

/**
 * Send one alert email via Resend.
 *
 * Never throws. Callers are sweeps whose real work (the log rows) is already
 * done by the time this runs, so a mail outage must not turn a successful
 * detection run into a failed one. The upstream body is read only to log it
 * and is not returned, because provider error text ends up in screenshots.
 */
export async function sendAdminAlertEmail(
  fetchImpl: AdminAlertFetch,
  config: AdminAlertConfig,
  message: { subject: string; text: string }
): Promise<AdminAlertResult> {
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: config.from,
        to: [config.to],
        subject: message.subject,
        text: message.text
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("admin-alert-email: resend failed", res.status, body.slice(0, 300));
      return "post_failed";
    }
    return "sent";
  } catch (err) {
    console.error("admin-alert-email: send threw", err);
    return "post_failed";
  }
}
