import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { coerceOwnerPhoneToE164 } from "@/lib/telnyx/assign-did";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type NotificationPreferencesRow = {
  business_id: string;
  sms_urgent: boolean;
  /**
   * Deliver urgent alerts over WhatsApp too (requires a connected WhatsApp
   * integration; out-of-window sends use the owner_alert template).
   * Optional on the type for rows read before 20260811210000.
   */
  whatsapp_urgent?: boolean;
  /**
   * Replace the urgent-alert SMS leg with WhatsApp when a connected WhatsApp
   * integration exists and whatsapp_urgent is on; SMS proceeds unchanged
   * otherwise. Default false (channels stay independent). Optional on the
   * type for rows read before 20260822125053.
   */
  whatsapp_replaces_sms?: boolean;
  /**
   * Post urgent alerts to the picked Slack channel (requires a connected
   * Slack workspace with an alert channel set). Optional on the type for
   * rows read before 20260822113305.
   */
  slack_urgent?: boolean;
  telegram_urgent?: boolean;
  teams_urgent?: boolean;
  google_chat_urgent?: boolean;
  /** Post the daily/weekly digest to the same Slack channel. */
  slack_digest?: boolean;
  /**
   * Deliver urgent owner alerts as a Web Push banner to every subscribed
   * device. Optional on the type for rows read before 20260829044308.
   *
   * There is deliberately no push_digest sibling: a push is an interrupt, and
   * a daily banner nobody taps would corrode the notificationclick receipt
   * that channel-liveness reads. See the migration for the full argument.
   */
  push_urgent?: boolean;
  email_digest: boolean;
  email_digest_weekly: boolean;
  /**
   * Send the monthly growth recap. Optional on the type for rows read before
   * 20260829061823; a missing value reads as ON, matching the column default.
   */
  email_monthly_recap?: boolean;
  email_urgent: boolean;
  dashboard_alerts: boolean;
  /** Text the recipient + owner on every voice warm transfer (success/failure). */
  sms_warm_transfer: boolean;
  /** Alert the owner when a coworker hits its per-session image-generation limit. */
  image_limit_alerts: boolean;
  /**
   * Opt-in (default false): notify the owner when a lead-intake AiFlow run
   * fails permanently (dead-letter), so a dead automation is never silent.
   */
  aiflow_failure_alerts: boolean;
  /**
   * Opt-in (default false): notify the owner when a customer texts the
   * business (per-contact coalescing; forward_owner contacts excluded).
   * KYP feedback, Jul 20 2026, "let me know when clients text back".
   */
  customer_reply_alerts: boolean;
  /**
   * ON by default: alert the owner when the AI confirms a booking for a
   * contact NO teammate owns (Truly, Jul 21 2026, a real broker call was
   * booked after hours and no human was ever told it existed). Optional on
   * the type for rows read before 20260819100000.
   */
  unassigned_booking_alerts?: boolean;
  /**
   * Who hears about a confirmed booking: the owner (default, and the only
   * behavior before 20260822180406), the employees, or both. The owner half
   * is the alert that already existed; the employee half is an SMS.
   */
  booking_alert_audience?: "owner" | "employees" | "both";
  /**
   * Narrow the employee half to these ai_flow_team_members ids. Null (or
   * empty) means every active member. Ignored when the audience is "owner".
   */
  booking_alert_member_ids?: string[] | null;
  /** Category filter: new-lead captures (see lib/notifications/categories.ts). */
  category_leads: boolean;
  /** Category filter: team-notify pings. */
  category_team: boolean;
  /** Category filter: platform/system events (number ports, etc.). */
  category_system: boolean;
  /**
   * Opt-in (default false): send digest emails only when the window had
   * customer-facing activity (customer texts, calls, new customers, urgent
   * alerts). Routine-only windows (background AiFlow runs, dashboard chat,
   * owner-directed sends the owner already received in real time) are
   * skipped. Optional on the type for rows read before 20260820100700.
   */
  digest_customer_facing_only?: boolean;
  phone_number: string | null;
  alert_email: string | null;
  /** Optional daily-digest recipient override; null = alert_email → owner_email chain. */
  digest_email_daily: string | null;
  /** Optional weekly-digest recipient override; null = alert_email → owner_email chain. */
  digest_email_weekly: string | null;
  /**
   * Set when the owner clicks "Unsubscribe from all" or hits a one-click
   * email-link unsubscribe. Cleared automatically when any toggle is flipped
   * back on (re-subscribing). The four boolean toggles remain the gate the
   * dispatcher checks, this column is for audit + UI banner copy only.
   */
  unsubscribed_at: string | null;
  updated_at: string;
};

/** Non-empty trimmed string, or null when missing/blank. */
function trimToNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/** Inputs for seeding contacts on **first insert** only (never on read/update). */
export type NotificationPreferenceContactSeeds = {
  userEmail: string | null;
  authPhone: string | null;
  ownerEmail: string | null;
  businessPhone: string | null;
};

/**
 * Derive initial `alert_email` / `phone_number` when creating a prefs row only.
 * Do not reuse for display merging: stored `null` must mean “cleared”, not “fill from auth”.
 *
 * Phone seeds are E.164-coerced, never passed through raw: `businesses.phone`
 * is free-form onboarding input (KYP Ads arrived as the 7-digit "5188192",
 * Jul 14 2026), and this value is what the alert dispatcher hands Telnyx as
 * the SMS `to`. A seed that can't be safely coerced is dropped, the form
 * shows an empty field the owner fills in (and the save route validates),
 * instead of pre-filling a number that could never receive an alert.
 */
export function initialNotificationPreferenceContactsFromSeeds(
  sources: NotificationPreferenceContactSeeds
): Pick<NotificationPreferencesRow, "alert_email" | "phone_number"> {
  return {
    alert_email:
      trimToNull(sources.userEmail) ?? trimToNull(sources.ownerEmail),
    phone_number:
      coerceOwnerPhoneToE164(sources.authPhone) ??
      coerceOwnerPhoneToE164(sources.businessPhone)
  };
}

/**
 * Display-time contact merge for the notifications form.
 *
 * Unlike {@link initialNotificationPreferenceContactsFromSeeds} (first-insert
 * only), this is safe to call on every render: it never writes to the DB. It
 * fills `alert_email` / `phone_number` from account info ONLY when the stored
 * value is null/blank, so the form is pre-populated from the owner's email +
 * business phone the first time they visit, answering "why isn't this
 * autofilled?", while a real stored value always wins.
 *
 * Tradeoff: because the merge is display-only, the stored row is unchanged
 * until the owner clicks Save, at which point the shown value is persisted.
 */
export function mergeNotificationContactsForDisplay(
  stored: Pick<NotificationPreferencesRow, "alert_email" | "phone_number">,
  seeds: NotificationPreferenceContactSeeds
): Pick<NotificationPreferencesRow, "alert_email" | "phone_number"> {
  const seeded = initialNotificationPreferenceContactsFromSeeds(seeds);
  return {
    alert_email: trimToNull(stored.alert_email) ?? seeded.alert_email,
    phone_number: trimToNull(stored.phone_number) ?? seeded.phone_number
  };
}

export type GetOrCreateNotificationPreferencesOpts = {
  client?: SupabaseClient;
  contactSeeds?: NotificationPreferenceContactSeeds;
};

export type NotificationPreferencesUpdate = Partial<
  Pick<
    NotificationPreferencesRow,
    | "sms_urgent"
    | "whatsapp_urgent"
    | "whatsapp_replaces_sms"
    | "slack_urgent"
    | "telegram_urgent"
    | "teams_urgent"
    | "google_chat_urgent"
    | "slack_digest"
    | "push_urgent"
    | "email_digest"
    | "email_digest_weekly"
    | "email_monthly_recap"
    | "email_urgent"
    | "dashboard_alerts"
    | "sms_warm_transfer"
    | "image_limit_alerts"
    | "aiflow_failure_alerts"
    | "customer_reply_alerts"
    | "unassigned_booking_alerts"
    | "booking_alert_audience"
    | "booking_alert_member_ids"
    | "category_leads"
    | "category_team"
    | "category_system"
    | "digest_customer_facing_only"
    | "phone_number"
    | "alert_email"
    | "digest_email_daily"
    | "digest_email_weekly"
    | "unsubscribed_at"
  >
>;

/**
 * Every column {@link updateNotificationPreferences} is allowed to write.
 *
 * This is a `Record` over the update type's keys, not a plain array, and the
 * difference is the whole point: `(keyof NotificationPreferencesUpdate)[]`
 * accepts any SUBSET, so adding a column to the type above and forgetting it
 * here compiles cleanly. The route then validates the new field, the UI shows
 * its toggle flipping, the save returns 200, and the column never changes.
 * There is no error anywhere and nothing to grep for.
 *
 * `Record<keyof Required<...>, true>` refuses to compile until every key is
 * present, so the next channel cannot repeat that. `Required` is needed
 * because several of these are optional on the row type (they postdate the
 * table), and `keyof` an optional property is still the key.
 */
const UPDATABLE_PREFERENCE_KEYS: Record<keyof Required<NotificationPreferencesUpdate>, true> = {
  sms_urgent: true,
  whatsapp_urgent: true,
  whatsapp_replaces_sms: true,
  slack_urgent: true,
  telegram_urgent: true,
  teams_urgent: true,
  google_chat_urgent: true,
  slack_digest: true,
  push_urgent: true,
  email_digest: true,
  email_digest_weekly: true,
  email_monthly_recap: true,
  email_urgent: true,
  dashboard_alerts: true,
  sms_warm_transfer: true,
  image_limit_alerts: true,
  aiflow_failure_alerts: true,
  customer_reply_alerts: true,
  unassigned_booking_alerts: true,
  booking_alert_audience: true,
  booking_alert_member_ids: true,
  category_leads: true,
  category_team: true,
  category_system: true,
  digest_customer_facing_only: true,
  phone_number: true,
  alert_email: true,
  digest_email_daily: true,
  digest_email_weekly: true,
  unsubscribed_at: true
};

const defaults: Omit<NotificationPreferencesRow, "business_id" | "updated_at"> = {
  sms_urgent: true,
  whatsapp_urgent: true,
  whatsapp_replaces_sms: false,
  slack_urgent: true,
  telegram_urgent: true,
  teams_urgent: true,
  google_chat_urgent: true,
  slack_digest: true,
  // NOT compiler-enforced, unlike UPDATABLE_PREFERENCE_KEYS above: the field
  // is optional on the row type (it postdates the table), so Omit<> does not
  // demand it here. Add every new channel toggle by hand.
  push_urgent: true,
  email_digest: true,
  email_digest_weekly: true,
  email_monthly_recap: true,
  email_urgent: true,
  dashboard_alerts: true,
  sms_warm_transfer: true,
  image_limit_alerts: true,
  aiflow_failure_alerts: false,
  customer_reply_alerts: false,
  unassigned_booking_alerts: true,
  booking_alert_audience: "owner",
  booking_alert_member_ids: null,
  category_leads: true,
  category_team: true,
  category_system: true,
  digest_customer_facing_only: false,
  phone_number: null,
  alert_email: null,
  digest_email_daily: null,
  digest_email_weekly: null,
  unsubscribed_at: null
};

/**
 * In-memory equivalent of the row {@link getOrCreateNotificationPreferences}
 * would insert (defaults, no contact seeds). For read-only rendering paths,
 * admin view-as previews a tenant who never opened the notifications page,
 * where creating the real row as a page-load side effect is not acceptable.
 */
export function defaultNotificationPreferencesRow(businessId: string): NotificationPreferencesRow {
  return {
    business_id: businessId,
    ...defaults,
    updated_at: new Date().toISOString()
  };
}

export function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "23505" ||
    error.message?.toLowerCase().includes("duplicate key") === true ||
    error.message?.toLowerCase().includes("unique constraint") === true
  );
}

export async function getNotificationPreferences(
  businessId: string,
  client?: SupabaseClient
): Promise<NotificationPreferencesRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("notification_preferences")
    .select()
    .eq("business_id", businessId)
    .maybeSingle();

  if (error) throw new Error(`getNotificationPreferences: ${error.message}`);
  return (data as NotificationPreferencesRow) ?? null;
}

export async function getOrCreateNotificationPreferences(
  businessId: string,
  opts?: GetOrCreateNotificationPreferencesOpts
): Promise<NotificationPreferencesRow> {
  const client = opts?.client;
  const existing = await getNotificationPreferences(businessId, client);
  if (existing) return existing;

  const db = client ?? (await createSupabaseServiceClient());
  const now = new Date().toISOString();
  const contactOverrides =
    opts?.contactSeeds !== undefined
      ? initialNotificationPreferenceContactsFromSeeds(opts.contactSeeds)
      : {};
  const { data, error } = await db
    .from("notification_preferences")
    .insert({
      business_id: businessId,
      ...defaults,
      ...contactOverrides,
      updated_at: now
    })
    .select()
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      const concurrent = await getNotificationPreferences(businessId, db);
      if (concurrent) return concurrent;
    }
    throw new Error(`getOrCreateNotificationPreferences: ${error.message}`);
  }
  return data as NotificationPreferencesRow;
}

export async function updateNotificationPreferences(
  businessId: string,
  patch: NotificationPreferencesUpdate,
  client?: SupabaseClient
): Promise<NotificationPreferencesRow> {
  await getOrCreateNotificationPreferences(businessId, client ? { client } : undefined);
  const db = client ?? (await createSupabaseServiceClient());
  const now = new Date().toISOString();

  const keys = Object.keys(UPDATABLE_PREFERENCE_KEYS) as (keyof NotificationPreferencesUpdate)[];
  const update: Record<string, unknown> = { updated_at: now };
  for (const key of keys) {
    const v = patch[key];
    if (v !== undefined) {
      update[key] = v;
    }
  }

  // Re-subscribe ergonomics: if the caller flipped any channel back on, also
  // clear unsubscribed_at unless they explicitly set it. Without this, an
  // owner who hit "Unsubscribe from all" then re-enabled email_urgent would
  // keep seeing the "you're unsubscribed" banner until a separate save.
  // digest_customer_facing_only, whatsapp_replaces_sms and the two
  // booking_alert_* fields are deliberately absent: they narrow or reroute
  // what an already-on channel delivers rather than turning a channel on, so
  // they never re-subscribe.
  const reSubscribed =
    update.unsubscribed_at === undefined &&
    (patch.sms_urgent === true ||
      patch.whatsapp_urgent === true ||
      patch.slack_urgent === true ||
      patch.telegram_urgent === true ||
      patch.teams_urgent === true ||
      patch.google_chat_urgent === true ||
      patch.slack_digest === true ||
      patch.push_urgent === true ||
      patch.email_digest === true ||
      patch.email_digest_weekly === true ||
      // Turning the monthly recap back on re-subscribes for the same reason
      // every other channel toggle does: the sweep checks the global flag
      // first, so leaving it set would make this switch do nothing.
      patch.email_monthly_recap === true ||
      patch.email_urgent === true ||
      patch.dashboard_alerts === true ||
      patch.sms_warm_transfer === true ||
      patch.image_limit_alerts === true ||
      patch.aiflow_failure_alerts === true ||
      patch.customer_reply_alerts === true ||
      patch.unassigned_booking_alerts === true);
  if (reSubscribed) {
    update.unsubscribed_at = null;
  }

  const { data, error } = await db
    .from("notification_preferences")
    .update(update)
    .eq("business_id", businessId)
    .select()
    .single();

  if (error) throw new Error(`updateNotificationPreferences: ${error.message}`);
  return data as NotificationPreferencesRow;
}
