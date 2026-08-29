/**
 * Central Web Push delivery: the one function that turns "notify this scope"
 * into encrypted pushes to every device registered for it.
 *
 * Structured outcomes instead of throws (the deliverWhatsApp / deliverSlackAlert
 * contract): the caller decides whether "not_connected" is silence (a business
 * that never subscribed a device records nothing) or an honest skipped row.
 *
 * Tier is RE-CHECKED at delivery time. A downgrade to starter silently stops
 * push traffic without deleting a single device row, the same rule every other
 * gated delivery path follows.
 *
 * Node-only by construction: VAPID signing is ECDSA P-256 and the payload is
 * aes128gcm, both node:crypto. Edge callers reach this through
 * /api/internal/push-send, exactly as they reach Slack and WhatsApp.
 */

import webpush, { WebPushError } from "web-push";
import { logger } from "@/lib/logger";
import { vapidKeysFromEnv } from "@/lib/push/keys";
import { buildPushPayload } from "@/lib/push/payload";
import { pushAllowedForBusiness } from "@/lib/push/tier-gate";
import {
  listDeliverablePushSubscriptions,
  revokePushSubscription,
  stampPushSent,
  type PushScope,
  type PushSubscriptionRow
} from "@/lib/push/db";

export type PushDeliveryResult =
  | { ok: true; sent: number; revoked: number }
  | {
      ok: false;
      reason:
        /** No device has ever subscribed for this scope. */
        | "not_connected"
        /** Devices existed and every one of them is gone. */
        | "all_expired"
        /** VAPID env is absent or half-set. */
        | "vapid_unconfigured"
        /** Business is below the Standard tier bar. */
        | "tier_blocked"
        /** The push service refused for a reason that is not expiry. */
        | "send_failed";
      detail?: string;
    };

export type PushDeliveryInput = {
  scope: PushScope;
  title: string;
  body: string;
  url: string;
  /** The `notifications` row id, so a tap can be attributed back to it. */
  notificationId?: string;
  tag?: string;
};

type SingleSendOutcome =
  | { ok: true }
  /** The subscription is provably gone. Revoke it. */
  | { ok: false; expired: true }
  /** Anything else. Do NOT revoke; see the 403 note below. */
  | { ok: false; expired: false; detail: string };

/**
 * 404 and 410 are the only statuses that mean "this subscription is gone".
 * The push services are contractually required to return them, which makes
 * expiry a fact rather than an inference.
 *
 * 403 is deliberately NOT here, and that omission is load-bearing. A 403
 * means the VAPID key does not match the subscription, which a botched key
 * rotation produces for EVERY device at once. Treating it as expiry would
 * revoke the entire fleet's subscriptions in a single dispatch, and the only
 * recovery would be asking every owner to re-install. Instead we log it and
 * let the registrar re-subscribe each device on its next dashboard load,
 * which works because the public key is served from a route rather than
 * baked into the bundle.
 *
 * 413 (payload too large) is our bug, not theirs, and buildPushPayload clamps
 * to prevent it, so a sighting is worth investigating rather than revoking.
 * 429 and 5xx are transient by definition.
 */
function isExpiredPushStatus(status: number): boolean {
  return status === 404 || status === 410;
}

async function sendOne(
  row: PushSubscriptionRow,
  payload: string
): Promise<SingleSendOutcome> {
  try {
    await webpush.sendNotification(
      {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth }
      },
      payload
    );
    return { ok: true };
  } catch (err) {
    if (err instanceof WebPushError) {
      if (isExpiredPushStatus(err.statusCode)) return { ok: false, expired: true };
      logger.warn("push.send: push service refused", {
        status: err.statusCode,
        // The endpoint is a capability URL; log only its host.
        host: safeHost(row.endpoint),
        subscriptionId: row.id
      });
      return { ok: false, expired: false, detail: `http_${err.statusCode}` };
    }
    return {
      ok: false,
      expired: false,
      detail: errText(err)
    };
  }
}

/** Message text from an unknown throw. One place, so it is one branch. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unparseable";
  }
}

export async function deliverPush(input: PushDeliveryInput): Promise<PushDeliveryResult> {
  const keys = vapidKeysFromEnv();
  if (!keys) return { ok: false, reason: "vapid_unconfigured" };

  // Delivery-time tier re-check, skipped for the platform scope (HQ admin
  // devices belong to no tenant). Fails TOWARD delivering on a read error,
  // because an alert must never be lost to a transient tier lookup blip.
  if (input.scope.businessId !== null) {
    try {
      if (!(await pushAllowedForBusiness(input.scope.businessId))) {
        return { ok: false, reason: "tier_blocked" };
      }
    } catch (err) {
      logger.warn("push.send: tier check failed, delivering anyway", {
        businessId: input.scope.businessId,
        error: errText(err)
      });
    }
  }

  let rows: PushSubscriptionRow[];
  try {
    rows = await listDeliverablePushSubscriptions(input.scope);
  } catch (err) {
    return {
      ok: false,
      reason: "send_failed",
      // A semantic label rather than errText here: a non-Error throw from the
      // read stringifies to "[object Object]", which tells an operator
      // nothing, whereas the failing STEP is the useful half.
      detail: err instanceof Error ? err.message : "subscription_read_failed"
    };
  }
  if (rows.length === 0) return { ok: false, reason: "not_connected" };

  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  const payload = buildPushPayload({
    title: input.title,
    body: input.body,
    url: input.url,
    notificationId: input.notificationId,
    tag: input.tag
  });

  const outcomes = await Promise.all(rows.map((row) => sendOne(row, payload)));

  const delivered: string[] = [];
  const expired: string[] = [];
  // Seeded rather than nullable: reaching the final return means at least
  // one send failed without expiring, so a "?? fallback" here would be a
  // branch on an unrepresentable state.
  let lastFailure = "no_devices_accepted";
  outcomes.forEach((outcome, i) => {
    const row = rows[i];
    if (outcome.ok) {
      delivered.push(row.id);
    } else if (outcome.expired) {
      expired.push(row.endpoint);
    } else {
      lastFailure = outcome.detail;
    }
  });

  // One dead device must never stop the others, so revocation happens after
  // every send has been attempted.
  for (const endpoint of expired) {
    try {
      await revokePushSubscription(endpoint, "expired");
    } catch (err) {
      logger.warn("push.send: revoke of an expired subscription failed", {
        host: safeHost(endpoint),
        error: errText(err)
      });
    }
  }

  if (delivered.length > 0) {
    try {
      await stampPushSent(delivered);
    } catch (err) {
      // Bookkeeping only. The pushes already landed, so this must not turn a
      // successful delivery into a reported failure.
      logger.warn("push.send: last_sent_at stamp failed", {
        error: errText(err)
      });
    }
    return { ok: true, sent: delivered.length, revoked: expired.length };
  }

  // Nothing landed. Distinguish "they all uninstalled" (a decision, and a
  // skip) from "the transport broke" (a fault, and a failure), so the
  // dispatcher does not page an admin every time somebody clears a browser.
  if (expired.length > 0) {
    return { ok: false, reason: "all_expired", detail: `${expired.length} expired` };
  }
  return { ok: false, reason: "send_failed", detail: lastFailure };
}
