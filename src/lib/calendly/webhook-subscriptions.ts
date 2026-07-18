/**
 * Calendly webhook subscription lifecycle (the invitee.created fast path).
 *
 * Webhook subscriptions are a PAID Calendly feature created via
 * POST /webhook_subscriptions; the response carries a per-subscription
 * `signing_key` exactly once. `ensureCalendlyWebhookSubscription` is called
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
 */
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
type SubscriptionResource = { resource?: { uri?: string; signing_key?: string } };
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
  try {
    const row = await getCalendlyWebhookSubscription(businessId, client);
    if (row?.status === "active") return { status: "active", attempted: false };
    if (row && nowMs - Date.parse(row.last_attempt_at) < CALENDLY_WEBHOOK_RETRY_COOLDOWN_MS) {
      return { status: row.status, attempted: false };
    }

    const record = async (
      status: CalendlyWebhookSubscriptionStatus,
      subscriptionUri?: string,
      signingKey?: string
    ): Promise<CalendlyWebhookEnsureResult> => {
      await upsertCalendlyWebhookSubscription(
        { businessId, status, subscriptionUri, signingKey },
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
      // path's perspective (the connection layer owns token health).
      return await record("error");
    }

    const callbackUrl = calendlyWebhookCallbackUrl(businessId);
    const createConfig: CalendlyRequestConfig = {
      endpoint: "/webhook_subscriptions",
      method: "POST",
      data: {
        url: callbackUrl,
        events: [...CALENDLY_WEBHOOK_EVENTS],
        organization: orgUri,
        user: userUri,
        scope: "user"
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
      if (
        typeof sub?.uri !== "string" ||
        sub.uri.length === 0 ||
        typeof sub.signing_key !== "string" ||
        sub.signing_key.length === 0
      ) {
        // A creation response without a signing key is unverifiable — treat
        // as an error rather than accepting unauthenticated webhooks.
        return record("error");
      }
      return record("active", sub.uri, sub.signing_key);
    };

    const first = await create();
    if (first !== "conflict") return first;

    // Conflict: an earlier subscription for this callback still exists but
    // its signing key is unrecoverable — delete it and re-create once.
    const listRes = await request(businessId, conn, {
      endpoint: "/webhook_subscriptions",
      method: "GET",
      params: { organization: orgUri, user: userUri, scope: "user", count: "100" }
    });
    const stale = ((listRes?.data as SubscriptionListing | undefined)?.collection ?? []).find(
      (s) => s?.callback_url === callbackUrl && typeof s.uri === "string" && s.uri.length > 0
    );
    if (!stale) return await record("error");
    await request(businessId, conn, {
      endpoint: `/webhook_subscriptions/${encodeURIComponent(resourceUuid(stale.uri as string))}`,
      method: "DELETE"
    });
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
