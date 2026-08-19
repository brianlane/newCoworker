/**
 * Pure helpers for the `voice-bridge-health-alerts` Edge cron.
 *
 * The Edge entrypoint (`../voice-bridge-health-alerts/index.ts`) is kept
 * deliberately thin: environment read, Supabase client construction, call
 * `findStaleBridges` + `findStuckSettlements`, dispatch alerts. All of the
 * business logic lives here so it can be unit-tested against a mocked
 * Supabase client without spinning up the Deno runtime.
 *
 * What we alert on:
 *   1. Stale bridge heartbeats, any tenant with voice routing enabled whose
 *      `business_telnyx_settings.bridge_last_heartbeat_at` is older than the
 *      threshold (default 5 min, matching the 30s heartbeat cadence × 10).
 *      A stale heartbeat means the voice-bridge container is down / wedged /
 *      not reporting, and any inbound calls for that DID will fail.
 *   2. Stuck voice_settlements, rows whose `first_signal_at` landed earlier
 *      than the grace window (default 30 min) AND `finalized_at IS NULL`.
 *      This is a liveness check on the settlement sweep itself; it should
 *      never find anything if `edge-voice-settlement-sweep` is firing.
 *
 * Alerts are emitted as telemetry_events (always) and optionally POSTed to a
 * Slack-compatible webhook (`ALERT_WEBHOOK_URL`). Dedup is intentionally
 * lightweight: we post once per run, upstream alert routing should dedupe
 * by event_type + payload hash if it gets noisy.
 */

/** A bridge whose last heartbeat is older than `stalenessMs`. */
export type StaleBridge = {
  business_id: string;
  bridge_last_heartbeat_at: string | null;
  age_seconds: number;
};

/** A voice_settlements row that never got finalized. */
export type StuckSettlement = {
  call_control_id: string;
  business_id: string;
  first_signal_at: string;
  age_seconds: number;
};

/**
 * Defaults chosen to minimize false-positives while still catching real
 * outages inside 5–10 minutes. Overridable via the `VOICE_HEALTH_*` Edge env.
 */
export const DEFAULT_BRIDGE_STALE_SECONDS = 300; // 5 min, 10 × heartbeat interval
export const DEFAULT_SETTLEMENT_STUCK_SECONDS = 1800; // 30 min, 6 × sweep cadence

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/** Return the subset of `rows` whose last heartbeat is older than `stalenessSeconds`. */
export function computeStaleBridges(
  rows: Array<{
    business_id: string;
    bridge_last_heartbeat_at: string | null;
    telnyx_connection_id: string | null;
    bridge_stale_alert_muted?: boolean | null;
  }>,
  nowMs: number,
  stalenessSeconds: number
): StaleBridge[] {
  const cutoffMs = nowMs - stalenessSeconds * 1000;
  const out: StaleBridge[] = [];
  for (const r of rows) {
    // Only page tenants that have actually wired Telnyx up, rows with no
    // `telnyx_connection_id` are shell rows created by onboarding and have
    // never been expected to heartbeat.
    if (!r.telnyx_connection_id) continue;

    // Per-tenant opt-out: internal tenants (e.g. NCW Flow Test) hold a DID
    // for SMS testing but intentionally run no voice bridge.
    if (r.bridge_stale_alert_muted) continue;

    if (r.bridge_last_heartbeat_at == null) {
      // A tenant with voice connected but NO heartbeat ever = bridge never
      // came up. Surface with sentinel age so alert payloads stay readable.
      out.push({
        business_id: r.business_id,
        bridge_last_heartbeat_at: null,
        age_seconds: -1
      });
      continue;
    }

    const hbMs = Date.parse(r.bridge_last_heartbeat_at);
    if (!Number.isFinite(hbMs)) continue;
    if (hbMs < cutoffMs) {
      out.push({
        business_id: r.business_id,
        bridge_last_heartbeat_at: r.bridge_last_heartbeat_at,
        age_seconds: Math.floor((nowMs - hbMs) / 1000)
      });
    }
  }
  return out;
}

/**
 * Return the subset of `rows` that count as "stuck": first signal arrived
 * more than `stuckSeconds` ago and `finalized_at` is still null.
 */
export function computeStuckSettlements(
  rows: Array<{
    call_control_id: string;
    business_id: string;
    first_signal_at: string | null;
    finalized_at: string | null;
  }>,
  nowMs: number,
  stuckSeconds: number
): StuckSettlement[] {
  const cutoffMs = nowMs - stuckSeconds * 1000;
  const out: StuckSettlement[] = [];
  for (const r of rows) {
    if (r.finalized_at != null) continue;
    if (!r.first_signal_at) continue;
    const sigMs = Date.parse(r.first_signal_at);
    if (!Number.isFinite(sigMs)) continue;
    if (sigMs < cutoffMs) {
      out.push({
        call_control_id: r.call_control_id,
        business_id: r.business_id,
        first_signal_at: r.first_signal_at,
        age_seconds: Math.floor((nowMs - sigMs) / 1000)
      });
    }
  }
  return out;
}

export type AlertPayload = {
  generated_at: string;
  stale_bridges: StaleBridge[];
  stuck_settlements: StuckSettlement[];
  thresholds: {
    bridge_stale_seconds: number;
    settlement_stuck_seconds: number;
  };
};

/** Rows named per section before the body starts counting instead. */
const EMAIL_MAX_ROWS = 10;

/**
 * The body of the paging EMAIL, as opposed to the chat blurb above.
 *
 * `formatAlertSummary` is counts and thresholds, which is right for a Slack
 * `text` field sitting beside attachments that carry the identities. Email
 * has no attachments, and since ALERT_WEBHOOK_URL has never been set in this
 * project, email is the only path that reaches a person at all. "3 stale
 * bridges" at 2am is not something anyone can act on: a stale bridge means
 * one specific tenant's inbound calls are failing, so the tenant has to be
 * in the message.
 *
 * Capped per section, because a fleet-wide outage would otherwise produce a
 * mail too long to read, and the count in the summary line already carries
 * the magnitude.
 */
export function formatAlertEmailBody(p: AlertPayload): string {
  const lines: string[] = [formatAlertSummary(p), ""];

  if (p.stale_bridges.length > 0) {
    lines.push(
      `Stale bridges (no heartbeat for over ${p.thresholds.bridge_stale_seconds}s).`,
      "Inbound calls to these tenants are failing right now:"
    );
    for (const b of p.stale_bridges.slice(0, EMAIL_MAX_ROWS)) {
      const age = b.age_seconds < 0 ? "never seen" : `${b.age_seconds}s ago`;
      const last = b.bridge_last_heartbeat_at ?? "never";
      lines.push(`  - ${b.business_id}: last heartbeat ${last} (${age})`);
    }
    const rest = p.stale_bridges.length - EMAIL_MAX_ROWS;
    if (rest > 0) lines.push(`  - and ${rest} more`);
    lines.push("");
  }

  if (p.stuck_settlements.length > 0) {
    lines.push(
      `Stuck settlements (unfinalized for over ${p.thresholds.settlement_stuck_seconds}s):`
    );
    for (const st of p.stuck_settlements.slice(0, EMAIL_MAX_ROWS)) {
      lines.push(
        `  - ${st.call_control_id} (tenant ${st.business_id}, ${st.age_seconds}s since first signal)`
      );
    }
    const rest = p.stuck_settlements.length - EMAIL_MAX_ROWS;
    if (rest > 0) lines.push(`  - and ${rest} more`);
    lines.push("");
  }

  lines.push(`Generated ${p.generated_at}.`);
  return lines.join("\n");
}

/** Short, chat-friendly summary suitable as a Slack/Discord `text` field. */
export function formatAlertSummary(p: AlertPayload): string {
  const bridgeCount = p.stale_bridges.length;
  const settleCount = p.stuck_settlements.length;
  const parts: string[] = [];
  if (bridgeCount > 0) {
    parts.push(
      `${bridgeCount} stale bridge${bridgeCount === 1 ? "" : "s"} (> ${p.thresholds.bridge_stale_seconds}s)`
    );
  }
  if (settleCount > 0) {
    parts.push(
      `${settleCount} stuck settlement${settleCount === 1 ? "" : "s"} (> ${p.thresholds.settlement_stuck_seconds}s)`
    );
  }
  if (parts.length === 0) return "voice health OK";
  return `voice health issue: ${parts.join(", ")}`;
}

export type WebhookFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * Fire a single webhook POST with a Slack-compatible JSON body. Errors are
 * caught and returned (never thrown) so the caller can record them without
 * failing the whole cron run.
 */
export async function postWebhook(
  fetchImpl: WebhookFetch,
  url: string,
  payload: AlertPayload
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const body = JSON.stringify({
      text: formatAlertSummary(payload),
      attachments: [
        {
          color: "#cc0000",
          fields: [
            {
              title: "Stale bridges",
              value: payload.stale_bridges
                .slice(0, 10)
                .map(
                  (b) =>
                    `• ${b.business_id}, ${b.age_seconds < 0 ? "never" : `${b.age_seconds}s`}`
                )
                .join("\n") || "none",
              short: false
            },
            {
              title: "Stuck settlements",
              value: payload.stuck_settlements
                .slice(0, 10)
                .map((s) => `• ${s.call_control_id} (biz=${s.business_id}, ${s.age_seconds}s)`)
                .join("\n") || "none",
              short: false
            }
          ]
        }
      ]
    });
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
