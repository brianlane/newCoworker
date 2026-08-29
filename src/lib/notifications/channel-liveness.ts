/**
 * Channel liveness: is a human still on the other end of this alert channel?
 *
 * WHY THIS EXISTS. `dispatchUrgentNotification` records a per-channel
 * outcome of sent / failed / skipped, and `reportFailedChannels` raises an
 * admin error when a leg FAILS. Both describe the transport. Neither
 * describes the human. A channel can be completely dead while every row
 * says `sent`, and KYP Ads ran that way for over a month on two channels at
 * once: 77 SMS alerts in 30 days to a number with no active SIM (every one
 * carrier-stamped `delivered`) and every WhatsApp send accepted by Meta and
 * then dropped on billing error 131042.
 *
 * A carrier receipt means a device on the network acknowledged the message.
 * It does not mean the intended person holds that device. No delivery-layer
 * telemetry can close that gap, which is why this module measures something
 * else: the REPLY, not the receipt. See
 * `.cursor/memory/feedback_delivered_is_not_received.md`.
 *
 * Everything here is pure. The reads live in `channel-liveness-sweep.ts`, so
 * the whole decision surface is testable without a database.
 */

/**
 * The six legs `dispatchUrgentNotification` fans out to, and the six values
 * `notifications.delivery_channel` can hold.
 */
export const LIVENESS_CHANNELS = [
  "sms",
  "email",
  "dashboard",
  "whatsapp",
  "slack",
  "telegram",
  "teams",
  "push"
] as const;

export type LivenessChannel = (typeof LIVENESS_CHANNELS)[number];

type ChannelVerdict =
  /** A human acted on this channel recently enough. */
  | "live"
  /** We alert on this channel and nobody has acted on it in the window. */
  | "silent"
  /** Too few alerts to tell "broken" from "we barely used it". */
  | "unused"
  /** We alert on it, but no evidence either way exists yet. */
  | "undecidable";

/**
 * Alerts a channel must carry inside the window before we are willing to
 * call it dead.
 *
 * Calibrated against the live fleet on 2026-08-28, and this gate is not
 * optional: six of eleven tenants sent between 1 and 3 alerts on their only
 * active channel over 30 days (Cedar Street Dental 1, KIN 2, Scar Fairy 3,
 * and the three review sandboxes 1-3 each). Without a floor every one of
 * them reads as permanently dark, which is six false alarms against two
 * real ones, and an alarm wrong three times out of four is one everybody
 * learns to close. Ten separates them cleanly from the genuinely-used
 * channels in the same read (Amy 58/64/86, KYP 16/77/109/136, New Coworker
 * 14/27).
 */
const LIVENESS_MIN_SENDS = 10;

/** The window every count and every signal age is measured over. */
export const LIVENESS_WINDOW_DAYS = 30;

/**
 * How long a channel may go without a human signal before it is dead.
 *
 * `null` means the channel is not judged by silence at all; see
 * `judgeChannel` for why email is the exception.
 *
 * Calibrated against the same read. Twenty-one days on a channel carrying
 * at least ten alerts a month means roughly seven consecutive alerts landed
 * with no human response, and it clears every healthy tenant with room to
 * spare: Amy's team replies to SMS within hours (0.1d), KYP's dashboard is
 * read at 3.9d, Amy's at 8.6d. It catches KYP's SMS at 35.1d, which is the
 * case this feature exists for.
 *
 * Slack is deliberately looser. The only Slack signal we have is the owner
 * POSTING, which is a weak proxy for reading a workspace they sit in all
 * day, and New Coworker's owner (the one healthy Slack tenant on the fleet)
 * last posted 17.5 days ago. Twenty-one would leave the only known-good
 * example three days from tripping, which is not a threshold, it is a
 * coin flip.
 *
 * Telegram sits with SMS and WhatsApp at 21 rather than with Slack at 30,
 * and the difference is what the signal MEANS. A Slack workspace is a room
 * somebody sits in all day whether or not they type; a Telegram thread with
 * their coworker is one they only open to say something. Silence there is
 * therefore closer to unanswered SMS than to an unposted-in workspace.
 *
 * This number has NOT yet been calibrated against real Telegram traffic,
 * because there is none: the channel ships with zero connected tenants.
 * Until one clears the ten-send floor every Telegram row reads `unused`,
 * which can neither darken nor rescue a tenant, so an unproven threshold
 * cannot raise a false alarm in the meantime. Re-run
 * debug/channel-liveness-report.ts once a tenant is connected and revisit
 * this with data, exactly as the numbers above were arrived at.
 *
 * Push is deliberately the TIGHTEST, at a third of the others, and the reason
 * is evidence quality rather than impatience. Every threshold above is loose
 * because its signal is a PROXY: an owner who reads every alert and answers
 * none looks identical to one who stopped receiving them, so the numbers buy
 * headroom against that false positive. Push has no such failure mode. Its
 * signal is a notificationclick, which fires only when a human taps the
 * specific banner carrying the specific alert, so absence of signal is far
 * closer to absence of reading.
 *
 * Seven and not three, because push is opportunistic: an owner can absorb a
 * lock-screen banner and act in another channel without ever tapping, and
 * three days would trip on a long weekend. Seven, against the ten-send floor,
 * means three or more consecutive alerts landed on a live subscription and
 * not one was opened. Two things keep that safe rather than trigger-happy:
 * a dead subscription is pruned at the delivery layer by its 404/410, so this
 * only ever judges the "subscription alive, nobody looks" case; and
 * judgeAudience escalates to `dark` only when NO channel is live, so a silent
 * push beside a live dashboard is a `degraded` warn, not a page.
 */
const CHANNEL_MAX_SILENCE_DAYS: Record<LivenessChannel, number | null> = {
  sms: 21,
  whatsapp: 21,
  slack: 30,
  telegram: 21,
  // Teams is a room somebody sits in all day, like Slack, so silence
  // there says less than an unanswered phone message. Same 30 as Slack,
  // and just as uncalibrated as Telegram until a tenant connects: every
  // Teams row reads `unused` below the ten-send floor, so an unproven
  // number cannot raise a false alarm meanwhile.
  teams: 30,
  dashboard: 21,
  push: 7,
  email: null
};

/**
 * Timestamps at or before this are the zero value, not a real event.
 *
 * `messenger_conversations.last_user_message_at` holds a literal
 * `1970-01-01T00:00:00+00:00` for a thread that exists but has never
 * received an inbound message, which is exactly the state of KYP's owner
 * WhatsApp thread. Reporting that as "56 years of silence" is technically
 * true and useless; it is an absence of evidence and reads as one.
 */
const SIGNAL_EPOCH_FLOOR_MS = Date.parse("2000-01-01T00:00:00Z");

export type ChannelEvidence = {
  channel: LivenessChannel;
  /** Alerts recorded `sent` on this channel inside the window. */
  sends: number;
  /**
   * Newest proof a human acted on this channel, or null for never.
   * Unused by the email leg, which has no reply signal (see `judgeChannel`).
   */
  lastHumanSignalAt: string | null;
  /**
   * Whether the signal is provably the ALERT AUDIENCE acting, rather than
   * anyone at all.
   *
   * Two channels can lie here, and both lies were found by running this
   * check against real data rather than by reading the schema:
   *
   *  - `notifications.read_at` carried no actor before
   *    `20260828...notification_read_actor`, and admin view-as has full
   *    tenant access, so a support session opening a tenant's notifications
   *    stamped it identically to the owner. Legacy rows stay unattributed
   *    forever.
   *  - `messenger_conversations` is mostly LEAD threads. Reading the newest
   *    `last_user_message_at` for KYP returns a lead who messaged hours ago
   *    and declares WhatsApp live, on the one tenant whose WhatsApp has been
   *    dead on billing error 131042 for weeks. The sweep matches the thread
   *    to an owner/roster number first; when it cannot, it says so here.
   *
   * An unattributed signal still counts as live (it is evidence, just weak
   * evidence), but the finding says so, because a soft signal presented as
   * a hard one is how false confidence gets built.
   */
  attributed: boolean;
  /** Email only: sends inside the window that carry a provider receipt. */
  receipted: number;
  /** Email only: receipted sends that bounced, complained, or hard-failed. */
  hardFailures: number;
};

export type ChannelJudgement = {
  channel: LivenessChannel;
  verdict: ChannelVerdict;
  sends: number;
  /** Days since the last human signal; null when never, or not silence-judged. */
  silentDays: number | null;
  attributed: boolean;
  /** One human-readable clause, used verbatim in the admin finding. */
  detail: string;
};

/** How the tenant's alert AUDIENCE is doing, across every channel at once. */
type AudienceState =
  /** Nothing reaches them: a channel has gone silent and none is live. */
  | "dark"
  /** A channel we actively send on is silent, but another still works. */
  | "degraded"
  /** Nothing is detectably broken. */
  | "live";

export type AudienceJudgement = {
  state: AudienceState;
  channels: ChannelJudgement[];
  silent: LivenessChannel[];
  live: LivenessChannel[];
};

function daysBetween(fromIso: string, nowMs: number): number {
  return (nowMs - Date.parse(fromIso)) / 86_400_000;
}

/**
 * A usable human-signal timestamp, or null.
 *
 * Null covers three different absences on purpose: no row at all, an
 * unparseable stamp, and the epoch sentinel above. All three mean the same
 * thing to a caller ("we have no evidence a human acted"), and collapsing
 * them here keeps every caller from re-deriving the sentinel rule.
 */
export function usableSignal(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  if (ms <= SIGNAL_EPOCH_FLOOR_MS) return null;
  return raw;
}

/**
 * Judge one channel.
 *
 * TWO DIFFERENT TESTS, because the channels are not alike.
 *
 * Reply-based (sms, whatsapp, slack, dashboard): a human did something we
 * can see. Silence past the threshold is the alarm.
 *
 * Delivery-based (email): the reply test is WRONG here, and shipping it
 * would have been the single worst decision in this feature. A prototype
 * that applied it uniformly flagged email as dead on nine of eleven
 * tenants, because no owner has ever replied to an alert email and every
 * inbound row in `email_log` across the whole fleet is vendor mail from
 * Telnyx, Hostinger and Zapier. Owners are not supposed to reply to alerts.
 * Email's real failure mode is a hard bounce, which the Resend receipts
 * capture directly, so email is judged live by the ABSENCE of bounces.
 *
 * `undecidable` is a first-class answer for email and is currently the
 * common one: `recordNotificationEmail` only started writing `email_log`
 * rows for alerts on 2026-08-26, so most of any 30-day window predates the
 * receipts. Saying "we cannot tell yet" is the honest output, and it
 * resolves itself as the window rolls forward rather than needing a fix.
 */
export function judgeChannel(evidence: ChannelEvidence, nowMs: number): ChannelJudgement {
  const { channel, sends, attributed } = evidence;
  const base = { channel, sends, attributed };

  if (sends < LIVENESS_MIN_SENDS) {
    return {
      ...base,
      verdict: "unused",
      silentDays: null,
      detail: `${sends} alert(s) in ${LIVENESS_WINDOW_DAYS}d, under the ${LIVENESS_MIN_SENDS} needed to judge it`
    };
  }

  const maxSilenceDays = CHANNEL_MAX_SILENCE_DAYS[channel];
  if (maxSilenceDays === null) {
    // Delivery-based. Every receipted send bounced => the address is dead.
    if (evidence.receipted === 0) {
      return {
        ...base,
        verdict: "undecidable",
        silentDays: null,
        detail: `${sends} sends in ${LIVENESS_WINDOW_DAYS}d, none carrying a delivery receipt yet`
      };
    }
    if (evidence.hardFailures >= evidence.receipted) {
      return {
        ...base,
        verdict: "silent",
        silentDays: null,
        detail: `all ${evidence.receipted} receipted send(s) of ${sends} bounced or hard-failed`
      };
    }
    return {
      ...base,
      verdict: "live",
      silentDays: null,
      detail: `${evidence.receipted - evidence.hardFailures} of ${evidence.receipted} receipted send(s) delivered`
    };
  }

  const signal = usableSignal(evidence.lastHumanSignalAt);
  if (signal === null) {
    return {
      ...base,
      verdict: "silent",
      silentDays: null,
      detail: `${sends} sends in ${LIVENESS_WINDOW_DAYS}d and no human signal EVER`
    };
  }

  const silentDays = daysBetween(signal, nowMs);
  if (silentDays > maxSilenceDays) {
    return {
      ...base,
      verdict: "silent",
      silentDays,
      detail: `${sends} sends in ${LIVENESS_WINDOW_DAYS}d, last human signal ${silentDays.toFixed(1)}d ago (limit ${maxSilenceDays}d)`
    };
  }
  return {
    ...base,
    verdict: "live",
    silentDays,
    detail: `last human signal ${silentDays.toFixed(1)}d ago`
  };
}

/**
 * Roll the per-channel verdicts up into one answer about the PEOPLE.
 *
 * A dead channel is not automatically a problem. An owner who ignores SMS
 * because they live in the dashboard is fine, and paging on that would be
 * noise. The question worth alarming on is whether ANY channel still
 * reaches them, so the state is a property of the audience and the channels
 * are the evidence for it.
 *
 * `undecidable` deliberately counts as neither. It cannot make things look
 * worse (an email channel we cannot read yet must not turn a healthy tenant
 * dark) and it cannot rescue a tenant either (it is not proof anyone is
 * there).
 */
export function judgeAudience(channels: ChannelJudgement[]): AudienceJudgement {
  const silent = channels.filter((c) => c.verdict === "silent").map((c) => c.channel);
  const live = channels.filter((c) => c.verdict === "live").map((c) => c.channel);
  const state: AudienceState =
    silent.length === 0 ? "live" : live.length === 0 ? "dark" : "degraded";
  return { state, channels, silent, live };
}

export type LivenessFinding = {
  level: "error" | "warn";
  event: "alert_audience_dark" | "alert_audience_degraded";
  message: string;
  payload: Record<string, unknown>;
};

/**
 * Turn a non-healthy audience judgement into the admin row, or null when
 * there is nothing to say.
 *
 * `dark` is an ERROR: it lands on the admin System Errors card next to
 * `alert_delivery_failed`, and it means somebody should phone the customer.
 * `degraded` is a WARN: they are still reachable, so it belongs in the
 * weekly digest and must not page.
 *
 * The message always names the channel that still WORKS, not just the ones
 * that do not. "Two of four channels are dead and here is which one still
 * reaches them" is actionable; "this customer is unreachable" is both
 * alarming and, on the tenant that motivated this, false.
 */
export function livenessFinding(
  businessName: string,
  judgement: AudienceJudgement
): LivenessFinding | null {
  if (judgement.state === "live") return null;
  const dark = judgement.state === "dark";
  const detailOf = (ch: LivenessChannel) =>
    `${ch} (${judgement.channels.find((c) => c.channel === ch)?.detail ?? "no detail"})`;
  const silentText = judgement.silent.map(detailOf).join(", ");
  return {
    level: dark ? "error" : "warn",
    event: dark ? "alert_audience_dark" : "alert_audience_degraded",
    message: dark
      ? `No alert channel is reaching anyone at ${businessName}. Silent: ${silentText}. No channel shows a human signal, so call them.`
      : `Alert channels have gone silent at ${businessName}. Silent: ${silentText}. Still reaching them: ${judgement.live.join(", ")}.`,
    payload: {
      state: judgement.state,
      silentChannels: judgement.silent,
      liveChannels: judgement.live,
      channels: judgement.channels.map((c) => ({
        channel: c.channel,
        verdict: c.verdict,
        sends: c.sends,
        silentDays: c.silentDays === null ? null : Number(c.silentDays.toFixed(1)),
        attributed: c.attributed,
        detail: c.detail
      }))
    }
  };
}
