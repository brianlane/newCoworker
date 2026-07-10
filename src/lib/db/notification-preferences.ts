import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type NotificationPreferencesRow = {
  business_id: string;
  sms_urgent: boolean;
  email_digest: boolean;
  email_digest_weekly: boolean;
  email_urgent: boolean;
  dashboard_alerts: boolean;
  /** Text the recipient + owner on every voice warm transfer (success/failure). */
  sms_warm_transfer: boolean;
  /** Alert the owner when a coworker hits its per-session image-generation limit. */
  image_limit_alerts: boolean;
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
   * dispatcher checks — this column is for audit + UI banner copy only.
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
 */
export function initialNotificationPreferenceContactsFromSeeds(
  sources: NotificationPreferenceContactSeeds
): Pick<NotificationPreferencesRow, "alert_email" | "phone_number"> {
  return {
    alert_email:
      trimToNull(sources.userEmail) ?? trimToNull(sources.ownerEmail),
    phone_number:
      trimToNull(sources.authPhone) ?? trimToNull(sources.businessPhone)
  };
}

/**
 * Display-time contact merge for the notifications form.
 *
 * Unlike {@link initialNotificationPreferenceContactsFromSeeds} (first-insert
 * only), this is safe to call on every render: it never writes to the DB. It
 * fills `alert_email` / `phone_number` from account info ONLY when the stored
 * value is null/blank, so the form is pre-populated from the owner's email +
 * business phone the first time they visit — answering "why isn't this
 * autofilled?" — while a real stored value always wins.
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
    | "email_digest"
    | "email_digest_weekly"
    | "email_urgent"
    | "dashboard_alerts"
    | "sms_warm_transfer"
    | "image_limit_alerts"
    | "phone_number"
    | "alert_email"
    | "digest_email_daily"
    | "digest_email_weekly"
    | "unsubscribed_at"
  >
>;

const defaults: Omit<NotificationPreferencesRow, "business_id" | "updated_at"> = {
  sms_urgent: true,
  email_digest: true,
  email_digest_weekly: true,
  email_urgent: true,
  dashboard_alerts: true,
  sms_warm_transfer: true,
  image_limit_alerts: true,
  phone_number: null,
  alert_email: null,
  digest_email_daily: null,
  digest_email_weekly: null,
  unsubscribed_at: null
};

/**
 * In-memory equivalent of the row {@link getOrCreateNotificationPreferences}
 * would insert (defaults, no contact seeds). For read-only rendering paths —
 * admin view-as previews a tenant who never opened the notifications page —
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

  const keys: (keyof NotificationPreferencesUpdate)[] = [
    "sms_urgent",
    "email_digest",
    "email_digest_weekly",
    "email_urgent",
    "dashboard_alerts",
    "sms_warm_transfer",
    "image_limit_alerts",
    "phone_number",
    "alert_email",
    "digest_email_daily",
    "digest_email_weekly",
    "unsubscribed_at"
  ];
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
  const reSubscribed =
    update.unsubscribed_at === undefined &&
    (patch.sms_urgent === true ||
      patch.email_digest === true ||
      patch.email_digest_weekly === true ||
      patch.email_urgent === true ||
      patch.dashboard_alerts === true ||
      patch.sms_warm_transfer === true ||
      patch.image_limit_alerts === true);
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
