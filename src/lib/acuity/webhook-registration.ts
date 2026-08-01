/**
 * Dynamic Acuity webhook registration.
 *
 * Acuity can be told programmatically where to send appointment events
 * (`POST /webhooks`), which spares the owner a copy-paste step. Registration
 * is BEST-EFFORT by design and has three documented ways to legitimately not
 * work, all of which are normal outcomes rather than errors:
 *
 *   - the account is at its **25-webhook ceiling** (Acuity answers 400);
 *   - the Webhooks API is not available to these credentials at all (the
 *     docs are written mostly from the OAuth-app perspective, so API-key
 *     access may be refused);
 *   - any other transport failure.
 *
 * In every one of those cases the dashboard card falls back to showing the
 * owner the tenant's webhook URL to paste into Acuity by hand, and the
 * ~1/min poller keeps triggers correct regardless. Webhooks buy latency
 * here, not capability, which is why nothing about this path is allowed to
 * fail a connect.
 *
 * Reconciling by TARGET rather than by stored id is deliberate: a reconnect,
 * a credential rotation, or a half-finished earlier attempt can all leave
 * registrations behind that our stored ids do not know about. Deleting
 * everything pointing at our own callback before re-creating makes the
 * operation idempotent no matter what state we find.
 */
import {
  ACUITY_WEBHOOK_EVENTS,
  AcuityApiError,
  createAcuityWebhook,
  deleteAcuityWebhook,
  listAcuityWebhooks
} from "@/lib/acuity/client";
import {
  readWebhookRegistration,
  setAcuityWebhookRegistration,
  type AcuityConnectionRow,
  type AcuityWebhookRegistration
} from "@/lib/db/acuity-connections";
import { recordSystemLog } from "@/lib/db/system-logs";
import { errorText } from "@/lib/acuity/errors";
import { logger } from "@/lib/logger";

/**
 * How stale a registration may be before a dashboard load re-checks it.
 *
 * Acuity disables a webhook after 5 days of continuous delivery failure, and
 * nothing tells us when it does. A daily re-check while an owner happens to
 * be on the page is cheap insurance; the poller is the real safety net.
 */
export const ACUITY_WEBHOOK_RECHECK_MS = 24 * 60 * 60 * 1000;

/** The tenant's callback URL. The token is defense in depth; the HMAC is the auth. */
export function acuityWebhookCallbackUrl(
  appOrigin: string,
  businessId: string,
  token: string
): string {
  const origin = appOrigin.replace(/\/+$/, "");
  return `${origin}/api/webhooks/acuity?business=${encodeURIComponent(businessId)}&token=${encodeURIComponent(token)}`;
}

export type EnsureWebhooksDeps = {
  list?: typeof listAcuityWebhooks;
  create?: typeof createAcuityWebhook;
  remove?: typeof deleteAcuityWebhook;
  persist?: typeof setAcuityWebhookRegistration;
  nowIso?: string;
};

/** Fill in the real transports for anything the caller did not inject. */
function resolveRegistrationDeps(deps: EnsureWebhooksDeps): Required<EnsureWebhooksDeps> {
  return {
    list: deps.list ?? listAcuityWebhooks,
    create: deps.create ?? createAcuityWebhook,
    remove: deps.remove ?? deleteAcuityWebhook,
    persist: deps.persist ?? setAcuityWebhookRegistration,
    nowIso: deps.nowIso ?? new Date().toISOString()
  };
}

/**
 * Reconcile this tenant's Acuity webhooks to exactly the events we consume.
 *
 * Never throws: every failure becomes a recorded status the card can explain.
 */
export async function ensureAcuityWebhooks(
  conn: AcuityConnectionRow,
  targetUrl: string,
  deps: EnsureWebhooksDeps = {}
): Promise<AcuityWebhookRegistration> {
  const { list, create, remove, persist, nowIso } = resolveRegistrationDeps(deps);

  const result: AcuityWebhookRegistration = {
    ids: [],
    targetUrl,
    registeredAt: null,
    status: "unsupported"
  };

  try {
    // Reconcile by target: anything already pointing at us is ours, whether
    // or not we still have its id.
    // Match the PREVIOUS callback URL as well as the current one. The origin
    // can drift (a NEXT_PUBLIC_APP_URL change, a different deployment host),
    // and registrations left at the old URL keep consuming the account's
    // 25-webhook ceiling while delivering to somewhere that no longer serves
    // this tenant.
    const stored = readWebhookRegistration(conn.webhook_registration);
    const ourTargets = new Set([targetUrl, ...(stored.targetUrl ? [stored.targetUrl] : [])]);
    const existing = await list(conn);
    for (const hook of existing) {
      if (!hook.target || !ourTargets.has(hook.target)) continue;
      try {
        await remove(conn, hook.id);
      } catch (err) {
        // A stale registration we cannot delete is not fatal; the create
        // below may still succeed, and a duplicate delivery is harmless
        // because the `cal:` dedupe keys collapse it.
        logger.warn("acuity webhooks: stale registration delete failed", {
          businessId: conn.business_id,
          webhookId: hook.id,
          error: errorText(err)
        });
      }
    }

    for (const event of ACUITY_WEBHOOK_EVENTS) {
      const created = await create(conn, event, targetUrl);
      if (created) result.ids.push(created.id);
    }
    // Only claim a live registration if we actually hold one. Acuity can
    // answer a create without an id, and we have just deleted whatever was
    // pointing at this target, so recording "registered" with zero ids would
    // assert a working webhook for an account that now has none, and the
    // recheck below would then never revisit it.
    if (result.ids.length > 0) {
      result.status = "registered";
      result.registeredAt = nowIso;
    }
  } catch (err) {
    // A 400 here is overwhelmingly the 25-per-account ceiling, which the
    // owner can actually do something about, so it gets its own status and
    // its own copy on the card.
    const capReached = err instanceof AcuityApiError && err.status === 400;
    result.status = capReached ? "cap_reached" : "unsupported";
    // Keep whatever we DID create so a later teardown can still remove it.
    logger.warn("acuity webhooks: registration incomplete", {
      businessId: conn.business_id,
      status: result.status,
      created: result.ids.length,
      error: errorText(err)
    });
  }

  try {
    await persist(conn.business_id, result);
  } catch (err) {
    logger.warn("acuity webhooks: persisting registration failed", {
      businessId: conn.business_id,
      error: errorText(err)
    });
  }
  return result;
}

/**
 * Remove the registrations we created. Best-effort: a connection is being
 * deleted, and a leftover webhook pointing at a tenant that no longer exists
 * is rejected by the receiver anyway.
 */
export async function teardownAcuityWebhooks(
  conn: AcuityConnectionRow,
  targetUrl: string | null,
  deps: EnsureWebhooksDeps = {}
): Promise<void> {
  const { list, remove } = resolveRegistrationDeps(deps);
  const stored = readWebhookRegistration(conn.webhook_registration);
  const ids = new Set(stored.ids);

  // Reconcile by TARGET as well as by stored id. `ensureAcuityWebhooks`
  // swallows a persistence failure, so the database can hold the PREVIOUS
  // set of ids while Acuity holds the new one. Deleting only what we have
  // stored would then orphan live registrations that keep consuming the
  // account's 25-webhook ceiling with no way for the owner to find them.
  const target = targetUrl ?? stored.targetUrl;
  if (target) {
    try {
      for (const hook of await list(conn)) {
        if (hook.target === target) ids.add(hook.id);
      }
    } catch (err) {
      logger.warn("acuity webhooks: teardown listing failed", {
        businessId: conn.business_id,
        error: errorText(err)
      });
    }
  }

  for (const id of ids) {
    try {
      await remove(conn, id);
    } catch (err) {
      logger.warn("acuity webhooks: teardown delete failed", {
        businessId: conn.business_id,
        webhookId: id,
        error: errorText(err)
      });
    }
  }
}

/**
 * Re-register if the stored registration has gone stale, so a webhook Acuity
 * silently disabled comes back without the owner noticing it was gone.
 * Returns null when nothing needed doing.
 */
export async function recheckAcuityWebhooks(
  conn: AcuityConnectionRow,
  targetUrl: string,
  nowMs: number,
  deps: EnsureWebhooksDeps = {}
): Promise<AcuityWebhookRegistration | null> {
  const stored = readWebhookRegistration(conn.webhook_registration);
  // Only re-check a registration that previously WORKED. Retrying a
  // cap_reached or unsupported account on every dashboard load would just
  // burn the shared per-IP budget to get the same answer.
  if (stored.status !== "registered") return null;
  if (stored.targetUrl === targetUrl && stored.registeredAt) {
    const age = nowMs - Date.parse(stored.registeredAt);
    if (Number.isFinite(age) && age < ACUITY_WEBHOOK_RECHECK_MS) return null;
  }

  const refreshed = await ensureAcuityWebhooks(conn, targetUrl, {
    ...deps,
    nowIso: deps.nowIso ?? new Date(nowMs).toISOString()
  });
  await recordSystemLog({
    businessId: conn.business_id,
    source: "acuity",
    level: "info",
    event: "acuity_webhook_rechecked",
    message: `Acuity webhook registration re-checked (${refreshed.status})`,
    payload: { status: refreshed.status, count: refreshed.ids.length }
  });
  return refreshed;
}
