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
 * A device that has not re-presented its subscription in this long is not
 * delivered to, even if nothing ever revoked it.
 *
 * Defence in depth, not the primary mechanism. Expiry is discovered
 * authoritatively at send time (404/410) and access loss is handled at the
 * write (`revokePushSubscriptionsForUser`). This is the backstop for any
 * future path that forgets both.
 */
const STALE_SUBSCRIPTION_DAYS = 60;

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

/** Live devices for one scope, freshest first. */
export async function listDeliverablePushSubscriptions(
  scope: PushScope,
  client?: SupabaseClient
): Promise<PushSubscriptionRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const staleBefore = new Date(
    Date.now() - STALE_SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const base = db.from("push_subscriptions").select(SUBSCRIPTION_COLUMNS);
  const { data, error } = await scopedQuery(base, scope)
    .is("revoked_at", null)
    .gt("last_seen_at", staleBefore)
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
  let query = db
    .from("push_subscriptions")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
    .eq("endpoint", endpoint)
    .is("revoked_at", null);
  if (opts.userId) query = query.eq("user_id", opts.userId);
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
 * "Is push applicable to this business at all?" for the dispatcher.
 *
 * FAILS TOWARD TRUE, matching slackAlertTargetState. This value decides
 * whether a business gets NO push row at all (the never-connected silence
 * rule) versus an honest skipped row, so a transient read blip must degrade
 * to the noisy-but-honest side. Reporting "not applicable" on a hiccup would
 * silently erase the channel from a tenant who really does have devices, and
 * leave nothing behind to notice it by.
 */
export async function pushTargetState(
  businessId: string,
  client?: SupabaseClient
): Promise<{ connected: boolean }> {
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
    if (error) return { connected: true };
    return { connected: (data as unknown[] | null)?.length ? true : false };
  } catch {
    return { connected: true };
  }
}

/**
 * Resolve one live subscription by endpoint, for the click receipt.
 *
 * The service worker posts back an endpoint it holds, and this is what turns
 * that into "which scope, and whose device". A revoked row resolves to null:
 * a tap on a notification delivered before an uninstall is not evidence the
 * channel is alive now.
 */
export async function findLivePushSubscription(
  endpoint: string,
  client?: SupabaseClient
): Promise<PushSubscriptionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("push_subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("endpoint", endpoint)
    .is("revoked_at", null)
    // One endpoint can legitimately exist under two scopes (a person who is
    // both an owner and an HQ admin in one browser), so this is limit(1), not
    // maybeSingle: maybeSingle ERRORS on a second row, which would turn a
    // supported state into a 500.
    .limit(1);
  if (error) throw new Error(`findLivePushSubscription: ${error.message}`);
  return ((data ?? []) as PushSubscriptionRow[])[0] ?? null;
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

/** Stamp a successful send so the staleness floor and support can see it. */
export async function stampPushSent(ids: string[], client?: SupabaseClient): Promise<void> {
  if (ids.length === 0) return;
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("push_subscriptions")
    .update({ last_sent_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw new Error(`stampPushSent: ${error.message}`);
}
