import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import { getActiveVagaroConnectionId } from "@/lib/db/vagaro-connections";
import { getActiveAcuityConnectionId } from "@/lib/db/acuity-connections";
import {
  getActiveCalendlyConnectionId,
  listActiveCalendlyConnections
} from "@/lib/db/calendly-connections";
import { getActiveCaldavConnectionId } from "@/lib/db/caldav-connections";

/**
 * Provider-config key groupings for voice tools.
 *
 * Nango uses its own identifier per provider config; we stored these when the
 * owner completed the Connect UI. For each logical capability (calendar,
 * email) we prefer Google if connected, otherwise fall back to Microsoft.
 */
// Dedicated calendar connections first; the broad full-scope "google" /
// "outlook" workspace connections (which include calendar read/write) act as
// fallbacks so owners who connected the all-in-one integration get calendar
// tools without reconnecting. Calendly (dashboard PAT, see
// CALENDLY_DIRECT_KEY) sits after the native calendars (it can only hand
// out booking links, not create events) but before the broad workspace
// fallbacks (a deliberate Calendly connect should win over an incidental
// all-in-one Google connect).
const NATIVE_CALENDAR_KEYS = ["google-calendar", "outlook-calendar"] as const;
const FALLBACK_CALENDAR_KEYS = ["google", "outlook"] as const;

/**
 * Synthetic providerConfigKey marking a DIRECT Calendly connection (owner
 * pasted a Personal Access Token on the dashboard, stored in
 * `calendly_connections`). This is the ONLY Calendly key: the legacy Nango
 * OAuth key "calendly" was removed from the resolver in the 2026-07 dead-
 * code sweep (production never had live Nango Calendly connections), so a
 * stray legacy `workspace_oauth_connections` row can no longer resolve as
 * a calendar connection.
 */
export const CALENDLY_DIRECT_KEY = "calendly-direct";

/**
 * Synthetic providerConfigKey marking a DIRECT CalDAV connection (owner
 * pasted server URL + app-specific password on the dashboard, stored in
 * `caldav_connections`). There is no Nango CalDAV path, this is the only
 * key for the provider.
 */
export const CALDAV_DIRECT_KEY = "caldav-direct";
// The broad all-in-one "google" workspace connection carries Gmail scopes
// (verified: the Gmail profile identity probe resolves on live connections),
// so it is a sendable/readable mailbox too. Dedicated mail connections come
// first, a deliberate Gmail connect wins over the all-in-one, and Google
// wins over Microsoft, matching calendar resolution. The broad "outlook"
// key doubles as the dedicated Microsoft mail key, so it is already here.
export const EMAIL_PROVIDER_CONFIG_KEYS = ["google-mail", "gmail", "google", "outlook"] as const;
const EMAIL_KEYS = EMAIL_PROVIDER_CONFIG_KEYS;

export type ResolvedVoiceConnection = {
  provider: "google" | "microsoft" | "calendly" | "vagaro" | "acuity" | "caldav";
  providerConfigKey: string;
  connectionId: string;
};

export function providerFromKey(key: string): "google" | "microsoft" {
  return key.startsWith("google") || key === "gmail" ? "google" : "microsoft";
}

/**
 * True for the providers that expose a real Google/Microsoft calendar via
 * the workspace proxy, the shared "NewCoworker" calendar and the calendar
 * trigger polling only exist for these; Calendly/Vagaro connections have
 * neither concept.
 */
export function isWorkspaceCalendarProvider(
  provider: ResolvedVoiceConnection["provider"]
): provider is "google" | "microsoft" {
  return provider === "google" || provider === "microsoft";
}

/** True when a stored provider_config_key is a sendable email mailbox. */
export function isEmailProviderConfigKey(key: string): boolean {
  return (EMAIL_PROVIDER_CONFIG_KEYS as readonly string[]).includes(key);
}

/**
 * Returns the first connection that matches any of `preferredKeys`, in the
 * order listed. Lets callers keep "Google first, Microsoft second" without
 * forking the code per provider.
 */
export async function resolveVoiceConnection(
  businessId: string,
  preferredKeys: readonly string[],
  need: "mail" | "any" = "any"
): Promise<ResolvedVoiceConnection | null> {
  const rows = await listWorkspaceOAuthConnections(businessId);
  return firstMatch(rows, preferredKeys, need);
}

type WorkspaceRow = Awaited<ReturnType<typeof listWorkspaceOAuthConnections>>[number];

/**
 * Scope substrings that prove a row can carry MAIL, per provider.
 *
 * Google: `gmail.modify` is the only Gmail scope we request, and it covers
 * read, send and label. Microsoft: either half of the mail pair is enough to be
 * offered, since a send-only grant is still a usable outbox.
 */
const MAIL_SCOPES: Record<"google" | "microsoft", readonly string[]> = {
  google: ["gmail.modify"],
  microsoft: ["Mail.ReadWrite", "Mail.Send"]
};

/**
 * Can this row actually serve the capability being resolved?
 *
 * Deliberately conservative: it answers false ONLY when the row proves it
 * cannot. Two rules, and the second is the one that matters.
 *
 * 1. A soft-disabled row cannot serve anything. The token manager sets
 *    `is_active = false` when a provider answers `invalid_grant`, so resolving
 *    one hands out a connection that is known dead. Worse, it does so INSTEAD of
 *    falling through to a working connection the tenant also has.
 *
 * 2. A row whose granted scope lacks the capability cannot serve it. Granular
 *    consent means an owner can untick Gmail and keep Calendar, and one live
 *    tenant did exactly that: KYP Ads' Google grant carries `calendar.events`
 *    and no `gmail.modify`. Because `google` precedes `outlook` in
 *    EMAIL_PROVIDER_CONFIG_KEYS, that row shadowed their two WORKING Outlook
 *    mailboxes, and every implicit email resolution for them returned a mailbox
 *    that answers 403.
 *
 * `oauth_scope` is NULL on Nango rows, and null means UNKNOWN, never "none".
 * Treating it as none would refuse every Nango mailbox on the fleet, which is
 * the opposite of the bug being fixed. Unknown stays eligible and fails later at
 * the API call, exactly as it does today.
 */
function canServe(row: WorkspaceRow, need: "mail" | "any"): boolean {
  // `=== false`, not `!row.is_active`: reject only when the row PROVES it is
  // disabled. The column is NOT NULL in the database so the distinction never
  // arises there, but the rule this function follows is "never treat unknown as
  // known", and a truthiness check would quietly reject a row that merely did
  // not carry the field.
  if (row.is_active === false) return false;
  if (need === "any") return true;
  const granted = row.oauth_scope;
  if (typeof granted !== "string" || granted.length === 0) return true;
  const wanted = MAIL_SCOPES[providerFromKey(row.provider_config_key)];
  return wanted.some((scope) => granted.includes(scope));
}

function firstMatch(
  rows: readonly WorkspaceRow[],
  preferredKeys: readonly string[],
  need: "mail" | "any" = "any"
): ResolvedVoiceConnection | null {
  for (const key of preferredKeys) {
    const match = rows.find((r) => r.provider_config_key === key && canServe(r, need));
    if (match) {
      return {
        // Every workspace-row key is Google or Microsoft: Calendly resolves
        // only through the direct-PAT branch below (CALENDLY_DIRECT_KEY).
        provider: providerFromKey(match.provider_config_key),
        providerConfigKey: match.provider_config_key,
        connectionId: match.connection_id
      };
    }
  }
  return null;
}

export async function resolveCalendarConnection(
  businessId: string
): Promise<ResolvedVoiceConnection | null> {
  // Vagaro is the business's REAL book when connected (dedicated scheduling
  // platform, not a workspace side calendar), it wins over every Nango
  // connection. Id-only probe: no secret decryption on this hot path.
  const vagaroId = await getActiveVagaroConnectionId(businessId);
  if (vagaroId) {
    return { provider: "vagaro", providerConfigKey: "vagaro", connectionId: vagaroId };
  }

  // Acuity sits in the same tier as Vagaro (a dedicated scheduling platform
  // holding the merchant's real book, with real availability reads and
  // writes), so it must beat an incidental all-in-one Google connect. It
  // sits BEHIND Vagaro purely because Vagaro is the incumbent: a tenant with
  // both connected must keep resolving to Vagaro, since a silent provider
  // switch on deploy is the one unacceptable outcome. Id-only probe, so no
  // secret is decrypted on this hot path.
  const acuityId = await getActiveAcuityConnectionId(businessId);
  if (acuityId) {
    return { provider: "acuity", providerConfigKey: "acuity", connectionId: acuityId };
  }

  const rows = await listWorkspaceOAuthConnections(businessId);
  const native = firstMatch(rows, NATIVE_CALENDAR_KEYS);
  if (native) return native;

  // Direct CalDAV (iCloud app-specific password etc.) sits after the
  // dedicated Google/Outlook calendars but ahead of Calendly: it supports
  // REAL free/busy + booking, while Calendly can only hand out links.
  const directCaldavId = await getActiveCaldavConnectionId(businessId);
  if (directCaldavId) {
    return {
      provider: "caldav",
      providerConfigKey: CALDAV_DIRECT_KEY,
      connectionId: directCaldavId
    };
  }

  // Direct (PAT) Calendly: after the dedicated Google/Outlook calendars,
  // before the broad workspace fallbacks. The only Calendly path, the
  // legacy Nango "calendly" fallback key was removed (dead code; production
  // never had live Nango Calendly connections).
  const directCalendlyId = await getActiveCalendlyConnectionId(businessId);
  if (directCalendlyId) {
    return {
      provider: "calendly",
      providerConfigKey: CALENDLY_DIRECT_KEY,
      connectionId: directCalendlyId
    };
  }

  return firstMatch(rows, FALLBACK_CALENDAR_KEYS);
}

/**
 * EVERY active direct-Calendly connection as a resolved conn, oldest
 * (primary) first. Booking-DETECTION surfaces (calendar-trigger poll,
 * booking precheck/goals, attendee lookups) iterate these so a booking on
 * ANY linked Calendly account is seen, a business can link several (e.g.
 * a teammate's own Calendly). Single-calendar surfaces keep resolving
 * through {@link resolveCalendarConnection}, which returns the primary.
 */
export async function listCalendlyCalendarConnections(
  businessId: string
): Promise<ResolvedVoiceConnection[]> {
  const rows = await listActiveCalendlyConnections(businessId);
  return rows.map((row) => ({
    provider: "calendly" as const,
    providerConfigKey: CALENDLY_DIRECT_KEY,
    connectionId: row.id
  }));
}

/**
 * A workspace calendar we can CREATE calendars and events on. Always Google
 * or Microsoft: no other provider exposes a calendar-create API.
 */
export type ResolvedCalendarHost = ResolvedVoiceConnection & {
  provider: "google" | "microsoft";
};

/**
 * Where the shared "NewCoworker" calendar should live, resolved INDEPENDENTLY
 * of which provider owns the business's bookings.
 *
 * This is deliberately not `resolveCalendarConnection`. That function answers
 * "who takes the booking?", and a dedicated scheduling platform wins it, so
 * a merchant who books on Vagaro but runs the rest of their business on
 * Google Workspace resolved to Vagaro, `isWorkspaceCalendarProvider` said no,
 * and they silently got NO team calendar at all. That is backwards: the
 * calendar is a place to SHOW the team what is booked, and a Google Workspace
 * account is a perfectly good place to show it no matter who took the
 * booking.
 *
 * So this looks only at `workspace_oauth_connections`, preferring a dedicated
 * calendar connection over the broad all-in-one one, exactly as calendar
 * resolution does. Null when the business has neither, which is the honest
 * answer: Vagaro, Acuity and Calendly have no calendar-create API, and
 * CalDAV's MKCALENDAR is not dependable (iCloud refuses it).
 */
export async function resolveSharedCalendarHost(
  businessId: string
): Promise<ResolvedCalendarHost | null> {
  const rows = await listWorkspaceOAuthConnections(businessId);
  const host = firstMatch(rows, NATIVE_CALENDAR_KEYS) ?? firstMatch(rows, FALLBACK_CALENDAR_KEYS);
  // Safe narrow: every workspace-row key is Google or Microsoft (firstMatch).
  return host as ResolvedCalendarHost | null;
}

/** A mailbox connection is always Google or Microsoft, never Calendly. */
export type ResolvedEmailConnection = ResolvedVoiceConnection & {
  provider: "google" | "microsoft";
};

export async function resolveEmailConnection(
  businessId: string
): Promise<ResolvedEmailConnection | null> {
  // Safe narrow: workspace-row resolution only ever produces
  // google/microsoft providers (see firstMatch).
  // "mail" rather than "any": a Google row that granted only Calendar precedes
  // `outlook` in EMAIL_KEYS, so without this it shadows a working Outlook
  // mailbox and every send resolves to a 403. See canServe.
  return (await resolveVoiceConnection(
    businessId,
    EMAIL_KEYS,
    "mail"
  )) as ResolvedEmailConnection | null;
}
