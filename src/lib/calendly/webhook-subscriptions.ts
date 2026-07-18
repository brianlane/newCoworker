/**
 * Calendly webhook subscription lifecycle (the invitee.created fast path).
 *
 * Webhook subscriptions are a PAID Calendly feature created via
 * POST /webhook_subscriptions; the platform mints its own per-subscription
 * `signing_key` and supplies it IN the create request (Calendly signs
 * deliveries with the shared secret — it does not return one).
 * `ensureCalendlyWebhookSubscription` is called
 * lazily from the booking-goal sweep for businesses that actually have
 * jumpable runs on booking-goal flows, so:
 *   - tenants whose plan supports webhooks get real-time
 *     appointment_booked goal events (receiver: /api/webhooks/calendly);
 *   - free-plan tenants get one refused attempt recorded as 'unsupported'
 *     and are re-tried only on a long cooldown (in case they upgrade);
 *   - the polling sweep keeps running for EVERYONE — the webhook only cuts
 *     latency, so a missed/failed delivery is healed within ~1-2 minutes.
 *
 * Subscriptions are user-scoped (scope "user" + the connected account's
 * uri), matching the sweep/poller semantics: we observe events where the
 * connected Calendly user is the host, not the whole organization.
 *
 * A 409 conflict ("hook with this url already exists") means an earlier
 * subscription survived a lost row (signing keys are unrecoverable after
 * creation) — recovery lists the subscriptions, deletes the one pointing at
 * our callback, and retries the create once.
 *
 * Account-switch safety (Bugbot on PR #746): every row records WHICH
 * platform connection created it (`<providerConfigKey>:<connectionId>`) and
 * WHICH Calendly user it observes. An active row only short-circuits while
 * the connection key still matches; when the connection changed, one
 * /users/me call re-validates the account — same user just refreshes the
 * stored key, a different user replaces the subscription (best-effort
 * remote delete of the old one first), so the receiver can never keep
 * firing goals off a previous Calendly account's bookings. A refused
 * (unsupported/error) row's cooldown is also scoped to its connection key:
 * reconnecting under a new account retries immediately (the new account may
 * be on a paid plan).
 */
import { randomBytes } from "crypto";
import {
  resolveCalendarConnection,
  type ResolvedVoiceConnection
} from "@/lib/voice-tools/connections";
import { calendlyRequest, type CalendlyRequestConfig } from "@/lib/calendar-tools/calendly";
import {
  deleteCalendlyWebhookSubscription,
  getCalendlyWebhookSubscription,
  upsertCalendlyWebhookSubscription,
  type CalendlyWebhookSubscriptionStatus
} from "@/lib/db/calendly-webhook-subscriptions";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** How long a refused/failed attempt suppresses re-tries. */
export const CALENDLY_WEBHOOK_RETRY_COOLDOWN_MS = 6 * 60 * 60_000;

/** The only event the receiver consumes today. */
export const CALENDLY_WEBHOOK_EVENTS = ["invitee.created"] as const;

/** Tenant-specific callback URL the subscription points at. */
export function calendlyWebhookCallbackUrl(businessId: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/api/webhooks/calendly?business=${businessId}`;
}

/** Bare UUID from a full Calendly resource URI ("" when unparseable). */
function resourceUuid(uri: string): string {
  const idx = uri.lastIndexOf("/");
  return idx >= 0 ? uri.slice(idx + 1) : uri;
}

/**
 * HTTP status from either transport's failure shape: CalendlyApiError
 * (direct PAT) carries `.status`; the Nango proxy throws axios-style errors
 * with `.response.status`.
 */
export function httpStatusOf(err: unknown): number | undefined {
  const anyErr = err as { status?: unknown; response?: { status?: unknown } } | null;
  if (typeof anyErr?.status === "number") return anyErr.status;
  if (typeof anyErr?.response?.status === "number") return anyErr.response.status;
  return undefined;
}

export type CalendlyWebhookEnsureDeps = {
  /** Injectable transport (tests). */
  request?: (
    businessId: string,
    conn: ResolvedVoiceConnection,
    config: CalendlyRequestConfig
  ) => Promise<{ data: unknown } | null>;
  nowMs?: number;
};

export type CalendlyWebhookEnsureResult = {
  status: CalendlyWebhookSubscriptionStatus;
  /** Whether this call actually talked to Calendly. */
  attempted: boolean;
};

type UserResource = { resource?: { uri?: string; current_organization?: string } };
type SubscriptionResource = { resource?: { uri?: string } };
type SubscriptionListing = { collection?: Array<{ uri?: string; callback_url?: string }> };

/**
 * Make sure this business has a live webhook subscription if its Calendly
 * plan allows one, respecting the retry cooldown. Never throws — the sweep
 * that calls this must keep polling regardless.
 */
export async function ensureCalendlyWebhookSubscription(
  businessId: string,
  conn: ResolvedVoiceConnection,
  deps: CalendlyWebhookEnsureDeps = {},
  client?: SupabaseClient
): Promise<CalendlyWebhookEnsureResult> {
  const request = deps.request ?? calendlyRequest;
  const nowMs = deps.nowMs ?? Date.now();
  const connectionKey = `${conn.providerConfigKey}:${conn.connectionId}`;
  try {
    const row = await getCalendlyWebhookSubscription(businessId, client);
    const sameConnection = row?.connection_key === connectionKey;
    if (row?.status === "active" && sameConnection) {
      return { status: "active", attempted: false };
    }
    if (
      row &&
      row.status !== "active" &&
      sameConnection &&
      nowMs - Date.parse(row.last_attempt_at) < CALENDLY_WEBHOOK_RETRY_COOLDOWN_MS
    ) {
      return { status: row.status, attempted: false };
    }

    const record = async (
      status: CalendlyWebhookSubscriptionStatus,
      subscriptionUri?: string,
      signingKey?: string,
      userUri?: string
    ): Promise<CalendlyWebhookEnsureResult> => {
      await upsertCalendlyWebhookSubscription(
        { businessId, status, subscriptionUri, signingKey, userUri, connectionKey },
        client
      );
      return { status, attempted: true };
    };

    const userRes = await request(businessId, conn, { endpoint: "/users/me", method: "GET" });
    const resource = (userRes?.data as UserResource | undefined)?.resource;
    const userUri = resource?.uri;
    const orgUri = resource?.current_organization;
    if (
      typeof userUri !== "string" ||
      userUri.length === 0 ||
      typeof orgUri !== "string" ||
      orgUri.length === 0
    ) {
      // Token refused or identity incomplete: transient from the webhook
      // path's perspective (the connection layer owns token health). An
      // ACTIVE row is left untouched — a flaky identity probe must not
      // destroy a working subscription; the mismatched connection key just
      // re-checks next tick.
      if (row?.status === "active") return { status: "error", attempted: true };
      return await record("error");
    }

    // Active row reached through a DIFFERENT connection: re-validate the
    // account behind it.
    if (row?.status === "active") {
      if (row.user_uri === userUri && row.subscription_uri && row.signingKey) {
        // Same Calendly account, new connection (e.g. Nango reconnect) —
        // the subscription is still right; just re-stamp the key.
        return await record("active", row.subscription_uri, row.signingKey, userUri);
      }
      // Different account (or an unusable legacy row): the old subscription
      // observes someone else's bookings now. Best-effort remote delete
      // (the old account's grant may already be gone), then subscribe fresh
      // under the current account.
      if (row.subscription_uri) {
        try {
          await request(businessId, conn, {
            endpoint: `/webhook_subscriptions/${encodeURIComponent(
              resourceUuid(row.subscription_uri)
            )}`,
            method: "DELETE"
          });
        } catch (err) {
          logger.warn("calendly webhook stale-subscription delete failed", {
            businessId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    const callbackUrl = calendlyWebhookCallbackUrl(businessId);
    // The signing key is CLIENT-supplied: Calendly's create accepts an
    // optional `signing_key` and does NOT return one in the response
    // resource (verified against the live API on 2026-07-18 — the shipped
    // wait-for-it-in-the-response contract left an orphaned hook we could
    // never verify). Mint our own high-entropy secret, send it, store it.
    const signingKey = randomBytes(32).toString("base64url");
    const createConfig: CalendlyRequestConfig = {
      endpoint: "/webhook_subscriptions",
      method: "POST",
      data: {
        url: callbackUrl,
        events: [...CALENDLY_WEBHOOK_EVENTS],
        organization: orgUri,
        user: userUri,
        scope: "user",
        signing_key: signingKey
      }
    };

    const create = async (): Promise<CalendlyWebhookEnsureResult | "conflict"> => {
      let res: { data: unknown } | null;
      try {
        res = await request(businessId, conn, createConfig);
      } catch (err) {
        const status = httpStatusOf(err);
        if (status === 409) return "conflict";
        // Plan gating: Calendly refuses webhook creation with 402/403 on
        // plans without the feature (the direct transport maps 403 to null,
        // handled below; the Nango proxy surfaces it as a thrown 403).
        if (status === 402 || status === 403) return record("unsupported");
        logger.warn("calendly webhook subscribe failed", {
          businessId,
          status: status ?? null,
          error: err instanceof Error ? err.message : String(err)
        });
        return record("error");
      }
      if (!res) {
        // The token verified moments ago on /users/me, so an auth-level
        // refusal on CREATE specifically is plan gating, not a dead token.
        return record("unsupported");
      }
      const sub = (res.data as SubscriptionResource | undefined)?.resource;
      if (typeof sub?.uri !== "string" || sub.uri.length === 0) {
        // A creation response without the resource URI leaves an unmanaged
        // hook we cannot reference — record the failure (the next attempt's
        // 409 recovery reaps it by callback URL).
        return record("error");
      }
      return record("active", sub.uri, signingKey, userUri);
    };

    const first = await create();
    if (first !== "conflict") return first;

    // Conflict: an earlier subscription for this callback still exists but
    // its signing key is unrecoverable — delete it and re-create once. The
    // stale hook may belong to a PREVIOUS Calendly user in the same
    // organization (account switch — Bugbot on PR #746), so when the
    // user-scoped listing misses, fall back to the organization-scoped one;
    // that lookup (and the delete after it) is permission-dependent, so a
    // refusal degrades to the recorded error and the polling sweep.
    const findStale = async (
      params: Record<string, string>
    ): Promise<{ uri: string } | null> => {
      try {
        const listRes = await request(businessId, conn, {
          endpoint: "/webhook_subscriptions",
          method: "GET",
          params: { organization: orgUri, count: "100", ...params }
        });
        const hit = ((listRes?.data as SubscriptionListing | undefined)?.collection ?? []).find(
          (s) => s?.callback_url === callbackUrl && typeof s.uri === "string" && s.uri.length > 0
        );
        return hit ? { uri: hit.uri as string } : null;
      } catch (err) {
        logger.warn("calendly webhook conflict listing failed", {
          businessId,
          scope: params.scope,
          error: err instanceof Error ? err.message : String(err)
        });
        return null;
      }
    };
    const stale =
      (await findStale({ user: userUri, scope: "user" })) ??
      (await findStale({ scope: "organization" }));
    if (!stale) return await record("error");
    try {
      await request(businessId, conn, {
        endpoint: `/webhook_subscriptions/${encodeURIComponent(resourceUuid(stale.uri))}`,
        method: "DELETE"
      });
    } catch (err) {
      // Record the failed attempt so last_attempt_at advances and the
      // cooldown applies — otherwise the sweep would repeat the whole
      // subscribe/conflict cycle every tick (Bugbot on PR #746).
      logger.warn("calendly webhook conflict delete failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return await record("error");
    }
    const second = await create();
    return second === "conflict" ? await record("error") : second;
  } catch (err) {
    // Persistence/unknown failure: leave state as-is; the next sweep tick
    // (or the cooldown) retries. Polling is unaffected either way.
    logger.warn("calendly webhook ensure failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { status: "error", attempted: false };
  }
}

export type CalendlyWebhookTeardownDeps = {
  request?: CalendlyWebhookEnsureDeps["request"];
  /** Injectable connection resolver (tests). */
  resolveConnection?: (businessId: string) => Promise<ResolvedVoiceConnection | null>;
};

/**
 * Best-effort teardown when the owner disconnects or disables Calendly:
 * delete the remote subscription (while we still can) and drop the row so
 * the receiver stops accepting deliveries. Never throws.
 */
export async function teardownCalendlyWebhookSubscription(
  businessId: string,
  deps: CalendlyWebhookTeardownDeps = {},
  client?: SupabaseClient
): Promise<void> {
  const request = deps.request ?? calendlyRequest;
  const resolveConnection = deps.resolveConnection ?? resolveCalendarConnection;
  try {
    const row = await getCalendlyWebhookSubscription(businessId, client);
    if (!row) return;
    if (row.subscription_uri) {
      try {
        const conn = await resolveConnection(businessId);
        if (conn?.provider === "calendly") {
          await request(businessId, conn, {
            endpoint: `/webhook_subscriptions/${encodeURIComponent(
              resourceUuid(row.subscription_uri)
            )}`,
            method: "DELETE"
          });
        }
      } catch (err) {
        // Remote delete is best-effort: the receiver refuses deliveries the
        // moment the row is gone, so an orphaned remote subscription is
        // noise on Calendly's side, not an auth hole on ours.
        logger.warn("calendly webhook remote delete failed", {
          businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    await deleteCalendlyWebhookSubscription(businessId, client);
  } catch (err) {
    logger.warn("calendly webhook teardown failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
