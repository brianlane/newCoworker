/**
 * Reads and writes for `push_subscriptions`.
 *
 * Service-role only: RLS is on with no policies, so nothing here is reachable
 * from a browser. Every caller is a route handler or the dispatcher.
 *
 * SCOPE. A subscription belongs to `{ businessId: string | null }`, where
 * null means the platform/HQ-admin scope. The type carries the nullability so
 * a caller cannot forget the second case, and every query filters with
 * `is not distinct from` semantics rather than `eq`, because `business_id =
 * NULL` matches nothing in SQL.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { deviceLabelFromUserAgent, type ParsedPushSubscription } from "@/lib/push/subscription";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Tenant scope, or the platform scope for HQ admin devices. */
export type PushScope = { businessId: string | null };

export type PushSubscriptionRow = {
  id: string;
  business_id: string | null;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_label: string | null;
  last_seen_at: string;
  revoked_at: string | null;
};

export type PushRevokeReason = "user" | "expired" | "membership" | "account";

const SUBSCRIPTION_COLUMNS =
  "id, business_id, user_id, endpoint, p256dh, auth, device_label, last_seen_at, revoked_at";

/**
 * PostgREST has no `is not distinct from`, and `.eq("business_id", null)`
 * serializes to `business_id=eq.null`, which matches zero rows. The platform
 * scope must therefore be expressed as `is.null`.
 *
 * This is the same class of bug as the `neq` / `isdistinct` trap in
 * channel-liveness-read: a NULL-blind filter silently returns an empty set
 * rather than erroring, so it reads as "this admin has no devices" forever.
 */
function scopedQuery<T extends { eq: (c: string, v: string) => T; is: (c: string, v: null) => T }>(
  query: T,
  scope: PushScope
): T {
  return scope.businessId === null
    ? query.is("business_id", null)
    : query.eq("business_id", scope.businessId);
}

/**
 * Register or refresh one browser's subscription.
 *
 * Upserts on (business_id, endpoint), which is a NULLS NOT DISTINCT unique
 * index so the platform scope dedupes too. Always clears `revoked_at`: a
 * browser presenting a subscription is the strongest possible evidence that
 * it is alive, and it is how a device recovers from an expiry or a
 * membership revoke that has since been undone.
 */
export async function upsertPushSubscription(
  input: {
    scope: PushScope;
    userId: string;
    subscription: ParsedPushSubscription;
    userAgent: string | null;
  },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const now = new Date().toISOString();
  const { error } = await db.from("push_subscriptions").upsert(
    {
      business_id: input.scope.businessId,
      user_id: input.userId,
      endpoint: input.subscription.endpoint,
      p256dh: input.subscription.keys.p256dh,
      auth: input.subscription.keys.auth,
      user_agent: input.userAgent,
      device_label: deviceLabelFromUserAgent(input.userAgent),
      last_seen_at: now,
      revoked_at: null,
      revoked_reason: null
    },
    { onConflict: "business_id,endpoint" }
  );
  if (error) throw new Error(`upsertPushSubscription: ${error.message}`);
}

/**
 * Live devices for one scope, freshest first.
 *
 * NOT filtered on how recently the device re-presented itself, deliberately.
 * An earlier version dropped anything whose `last_seen_at` was over 60 days
 * old, as defence in depth. That was exactly backwards: `last_seen_at` is
 * only bumped when someone opens the dashboard, so the floor expired the very
 * owner push exists to serve, the one who reads lock-screen banners and never
 * logs in. Worse, it disagreed with `pushTargetState`, which applies no such
 * floor: the dispatcher would see "connected", the send would find nothing,
 * and the leg would write NO row, so the owner vanished from the channel with
 * no skipped history and no liveness signal to notice it by.
 *
 * The two mechanisms that actually retire a device are authoritative and
 * complete: a 404/410 at send time (the push service saying it is gone) and
 * `revokePushSubscriptionsForUser` at the moment access is lost.
 */
export async function listDeliverablePushSubscriptions(
  scope: PushScope,
  client?: SupabaseClient
): Promise<PushSubscriptionRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const base = db.from("push_subscriptions").select(SUBSCRIPTION_COLUMNS);
  const { data, error } = await scopedQuery(base, scope)
    .is("revoked_at", null)
    .order("last_seen_at", { ascending: false });
  if (error) throw new Error(`listDeliverablePushSubscriptions: ${error.message}`);
  return (data ?? []) as PushSubscriptionRow[];
}

/**
 * Revoke one endpoint.
 *
 * `userId`, when supplied, is part of the predicate rather than a check
 * afterwards, so one signed-in person can never revoke another person's
 * device by guessing an endpoint. The send path omits it, because a 410 from
 * the push service is authoritative regardless of who owns the row.
 */
export async function revokePushSubscription(
  endpoint: string,
  reason: PushRevokeReason,
  opts: { userId?: string; client?: SupabaseClient } = {}
): Promise<void> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const base = db
    .from("push_subscriptions")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
    .eq("endpoint", endpoint)
    .is("revoked_at", null);
  const query = opts.userId ? base.eq("user_id", opts.userId) : base;
  const { error } = await query;
  if (error) throw new Error(`revokePushSubscription: ${error.message}`);
}

/**
 * Revoke every device a person registered against one business.
 *
 * Called when their membership is removed. Expiry hygiene at send time
 * cannot cover this: their subscription is perfectly alive, it just must
 * stop receiving a tenant's alerts the moment they lose access to it.
 */
export async function revokePushSubscriptionsForUser(
  businessId: string,
  userId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("push_subscriptions")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: "membership" })
    .eq("business_id", businessId)
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw new Error(`revokePushSubscriptionsForUser: ${error.message}`);
}

/**
 * Move a rotated subscription onto its new endpoint, KEEPING its scopes.
 *
 * `pushsubscriptionchange` fires when a browser rotates a subscription, and
 * the service worker has no idea which business the device was registered
 * against. It cannot guess: the platform scope is admin-only, so guessing
 * `null` gets a tenant device a 403 and the rotated endpoint is never stored,
 * leaving that device silent until the owner happens to open the dashboard.
 *
 * So the worker sends the OLD endpoint and this re-points every row the
 * caller owns at it. The old endpoint is a SELECTOR here, never proof of
 * identity: the session cookie authenticates, and `user_id` is part of the
 * predicate, so possessing a leaked endpoint buys nothing. That distinction
 * is the whole reason this is safe and a `previousEndpoint`-as-auth scheme
 * would not be.
 *
 * Returns how many scopes moved, so the route can tell "rotated" from
 * "nothing of yours was there".
 */
export async function repointPushSubscription(
  input: {
    previousEndpoint: string;
    userId: string;
    subscription: ParsedPushSubscription;
    userAgent: string | null;
  },
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("push_subscriptions")
    .select("business_id")
    .eq("endpoint", input.previousEndpoint)
    .eq("user_id", input.userId)
    /**
     * Live rows OR ones we retired as `expired`, and nothing else.
     *
     * A rotation usually races the send that discovered the death: the push
     * service 410s, the send path stamps `revoked_reason = 'expired'`, and
     * THEN pushsubscriptionchange arrives with the replacement. Filtering on
     * `revoked_at is null` alone made that ordering find nothing, return 0,
     * and drop the new endpoint on the floor, which is the exact outage this
     * handler exists to prevent.
     *
     * `user` and `membership` revocations are deliberately NOT included. Those
     * are decisions (the owner turned push off; a teammate lost access), and a
     * browser rotating its subscription must never quietly undo one.
     */
    .or("revoked_at.is.null,revoked_reason.eq.expired");
  if (error) throw new Error(`repointPushSubscription: ${error.message}`);

  const scopes = (data as { business_id: string | null }[] | null) ?? [];
  if (scopes.length === 0) return 0;

  // Upsert rather than UPDATE the endpoint in place: the same browser may
  // already hold a row at the new endpoint for this scope, and the unique
  // index would refuse a plain update.
  for (const { business_id } of scopes) {
    await upsertPushSubscription(
      {
        scope: { businessId: business_id },
        userId: input.userId,
        subscription: input.subscription,
        userAgent: input.userAgent
      },
      db
    );
  }
  /**
   * Only retire the OLD endpoint when it is genuinely a different one.
   *
   * Safari does not populate `event.oldSubscription`, so the worker falls back
   * to the registration's current subscription; `subscribe()` with an
   * unchanged VAPID key then hands back that same subscription, and the POST
   * arrives with previousEndpoint === endpoint. Revoking unconditionally
   * stamped `revoked_at` on the row the upsert had just written and killed a
   * perfectly working device until its owner next opened the dashboard.
   */
  if (input.previousEndpoint !== input.subscription.endpoint) {
    await revokePushSubscription(input.previousEndpoint, "expired", {
      userId: input.userId,
      client: db
    });
  }
  return scopes.length;
}

/**
 * "Is push applicable to this business at all?" for the dispatcher.
 *
 * TWO answers, failing in OPPOSITE directions, exactly as WhatsApp's twin
 * does, because they gate different things.
 *
 * `connected` asks "is this channel applicable to this business at all?" and
 * FAILS TOWARD TRUE. It decides whether a business gets no push row versus an
 * honest skipped row, so a read blip must degrade to the noisy-but-honest
 * side; reporting "not applicable" on a hiccup would erase the channel from a
 * tenant who really does have devices and leave nothing to notice it by.
 *
 * `deliverable` asks "can it actually deliver right now?" and FAILS TOWARD
 * FALSE, because it is the gate that SUPPRESSES the SMS leg for
 * push_replaces_sms. Treating a read blip as "yes" would silence the owner's
 * text on the strength of a push we never confirmed could land, leaving them
 * with no phone channel at all. That is the WhatsApp bug (Bugbot f574b3a4)
 * one channel over, and this is the shape that avoids it.
 */
export async function pushTargetState(
  businessId: string,
  client?: SupabaseClient
): Promise<{ connected: boolean; deliverable: boolean }> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("push_subscriptions")
      .select("id")
      .eq("business_id", businessId)
      .is("revoked_at", null)
      // limit(1), NOT maybeSingle: this table is one row per DEVICE, and
      // maybeSingle throws on a second row. Copying the Slack leg's
      // maybeSingle here would make the check error for every business with
      // two phones, and the fail-open default would hide it forever.
      .limit(1);
    if (error) return { connected: true, deliverable: false };
    const live = (data as unknown[] | null)?.length ? true : false;
    return { connected: live, deliverable: live };
  } catch {
    return { connected: true, deliverable: false };
  }
}

/**
 * Every live subscription for an endpoint, for the click receipt.
 *
 * Returns a LIST, not one row, and that is the whole point. One endpoint can
 * legitimately exist under two scopes at once: a person who is both a business
 * owner and an HQ admin, subscribed in the same browser, has a tenant row and
 * a platform row sharing an endpoint. Taking `limit(1)` off an unordered read
 * picked between them arbitrarily, which meant a tap either recorded nothing
 * (platform row won) or was filed as that TENANT's liveness evidence when the
 * banner was actually a platform alert (tenant row won). Neither is a thing
 * this check is allowed to guess at, so the caller resolves the scope from the
 * notification instead.
 *
 * Revoked rows are excluded: a tap on a notification delivered before an
 * uninstall is not evidence the channel is alive now.
 */
export async function listLivePushSubscriptions(
  endpoint: string,
  client?: SupabaseClient
): Promise<PushSubscriptionRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("push_subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("endpoint", endpoint)
    .is("revoked_at", null);
  if (error) throw new Error(`listLivePushSubscriptions: ${error.message}`);
  return (data ?? []) as PushSubscriptionRow[];
}

/**
 * Record a tap on a delivered push.
 *
 * Writes into `notification_link_clicks`, the table built for owner clicks,
 * with `channel = 'push'`. `likely_prefetch` is pinned false and that is a
 * statement of fact rather than a default: the prefetch problem exists
 * because messaging apps and carrier scanners fetch every link on delivery,
 * and no such actor can fire a notificationclick. It only happens when a
 * person taps.
 */
export async function recordPushClick(
  input: { businessId: string; notificationId?: string },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("notification_link_clicks").insert({
    business_id: input.businessId,
    link_id: null,
    channel: "push",
    source: "push_alert",
    notification_id: input.notificationId ?? null,
    likely_prefetch: false
  });
  if (error) throw new Error(`recordPushClick: ${error.message}`);
}

/**
 * Retire every device a person registered, across every scope.
 *
 * Called when their account is deleted. `push_subscriptions.user_id`
 * deliberately carries no FK to auth.users (deleting a login must not erase
 * the record of what we sent where), so nothing cascades and this is the only
 * thing that stops the handset. Without it a deleted user's browser keeps
 * receiving a business's alerts until the push service happens to 410 the
 * subscription, which for a live device may be never.
 */
export async function revokePushSubscriptionsForAccount(
  userId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("push_subscriptions")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: "account" })
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(`revokePushSubscriptionsForAccount: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length;
}

/** Stamp a successful send so support can see it. */
export async function stampPushSent(ids: string[], client?: SupabaseClient): Promise<void> {
  if (ids.length === 0) return;
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("push_subscriptions")
    .update({ last_sent_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw new Error(`stampPushSent: ${error.message}`);
}
