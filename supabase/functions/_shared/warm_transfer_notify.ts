/**
 * Warm-transfer SMS notifications.
 *
 * On every voice warm transfer we text the recipient (and, when the recipient
 * isn't the tenant owner, the owner too) with the outcome + caller identity.
 * Detection happens on the Telnyx webhook side: `call.bridged` on a transfer
 * leg = a human answered (success); `call.hangup` with no prior bridge =
 * no-answer (failure).
 *
 * The pure helpers (client_state encode/parse, label + message builders,
 * shouldNotifyOwner) are dependency-free so the Vitest suite can import them
 * directly. `sendWarmTransferNotifications` is impure (Supabase + Telnyx) and is
 * only invoked from the Deno edge function.
 */
import { telnyxSendSms } from "./telnyx_sms_compliance.ts";

export type WtOutcome = "success" | "failed";

export const WT_CS_PREFIX = "wt";

export type WtClientState = {
  businessId: string;
  /** Caller's E.164 (may be empty for an anonymous / withheld inbound number). */
  callerE164: string;
  /** Transfer target's E.164. */
  recipientE164: string;
};

/**
 * Plain-text client_state we attach to a warm-transfer leg:
 * `wt:<businessId>:<callerE164>:<recipientE164>`. Telnyx requires client_state
 * to be base64; the transfer helpers base64-encode it, so this returns plain
 * text (mirrors `encodeHandoffClientState`).
 */
export function encodeWtClientState(state: WtClientState): string {
  return `${WT_CS_PREFIX}:${state.businessId}:${state.callerE164}:${state.recipientE164}`;
}

/**
 * Parse the client_state echoed on a transfer leg's webhook. Telnyx returns it
 * base64-encoded, so we decode first when it isn't already the plain `wt:...`
 * form (covers both real webhooks and direct unit tests).
 */
export function parseWtClientState(raw: string | null | undefined): WtClientState | null {
  if (!raw) return null;
  let text = raw;
  if (!text.startsWith(`${WT_CS_PREFIX}:`)) {
    try {
      text = atob(raw);
    } catch {
      return null;
    }
  }
  if (!text.startsWith(`${WT_CS_PREFIX}:`)) return null;
  // businessId is a uuid and both numbers are E.164 — none contain ':', so a
  // plain split yields exactly 4 segments.
  const parts = text.split(":");
  if (parts.length !== 4) return null;
  const [, businessId, callerE164, recipientE164] = parts;
  if (!businessId || !recipientE164) return null;
  return { businessId, callerE164, recipientE164 };
}

function normE164(e164: string | null | undefined): string {
  return (e164 ?? "").trim();
}

/** "Brian Lane +1602…" when both known, else name, else number, else fallback. */
export function labelFor(
  name: string | null | undefined,
  e164: string | null | undefined,
  fallback = "the caller"
): string {
  const n = (name ?? "").trim();
  const num = normE164(e164);
  if (n && num) return `${n} ${num}`;
  if (n) return n;
  if (num) return num;
  return fallback;
}

/** Notify the owner only when an owner number exists and differs from the recipient. */
export function shouldNotifyOwner(
  recipientE164: string | null | undefined,
  ownerE164: string | null | undefined
): boolean {
  const owner = normE164(ownerE164);
  const recipient = normE164(recipientE164);
  if (!owner) return false;
  return owner !== recipient;
}

/** True when the transfer recipient IS the tenant owner. */
export function recipientIsOwner(
  recipientE164: string | null | undefined,
  ownerE164: string | null | undefined
): boolean {
  const owner = normE164(ownerE164);
  const recipient = normE164(recipientE164);
  return owner !== "" && owner === recipient;
}

export function buildRecipientMessage(outcome: WtOutcome, callerLabel: string): string {
  return outcome === "success"
    ? `Warm transfer successful for ${callerLabel}.`
    : `Missed warm transfer for ${callerLabel} — please follow up.`;
}

export function buildOwnerMessage(
  outcome: WtOutcome,
  recipientLabel: string,
  callerLabel: string
): string {
  return outcome === "success"
    ? `${recipientLabel} received a successful warm transfer for ${callerLabel}.`
    : `${recipientLabel} missed a warm transfer for ${callerLabel}.`;
}

// ---------------------------------------------------------------------------
// Impure: name resolution + dedup-gated send. Edge-only.
// ---------------------------------------------------------------------------

/** Minimal structural view of the Supabase client (avoids importing supabase-js here). */
type SupabaseLike = {
  from: (table: string) => any;
};

async function lookupContactName(
  supabase: SupabaseLike,
  businessId: string,
  e164: string
): Promise<string> {
  if (!e164) return "";
  try {
    const { data } = await supabase
      .from("contacts")
      .select("display_name")
      .eq("business_id", businessId)
      .eq("customer_e164", e164)
      .maybeSingle();
    return ((data as { display_name?: string } | null)?.display_name ?? "").trim();
  } catch {
    return "";
  }
}

async function lookupOwnerName(supabase: SupabaseLike, businessId: string): Promise<string> {
  try {
    const { data } = await supabase
      .from("businesses")
      .select("owner_name")
      .eq("id", businessId)
      .maybeSingle();
    return ((data as { owner_name?: string } | null)?.owner_name ?? "").trim();
  } catch {
    return "";
  }
}

async function lookupTeamName(
  supabase: SupabaseLike,
  businessId: string,
  e164: string
): Promise<string> {
  if (!e164) return "";
  try {
    const { data } = await supabase
      .from("ai_flow_team_members")
      .select("name")
      .eq("business_id", businessId)
      .eq("phone_e164", e164)
      .maybeSingle();
    return ((data as { name?: string } | null)?.name ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * Send the recipient (and conditionally owner) warm-transfer SMS, gated on a
 * dedup claim so retried/duplicate webhooks don't double-text. Best-effort:
 * never throws; returns why it skipped for telemetry.
 */
export async function sendWarmTransferNotifications(
  supabase: SupabaseLike,
  apiKey: string,
  args: {
    businessId: string;
    callerE164: string;
    recipientE164: string;
    outcome: WtOutcome;
    dedupeKey: string;
  }
): Promise<{ sent: boolean; reason?: string }> {
  const { businessId, callerE164, recipientE164, outcome, dedupeKey } = args;
  if (!apiKey) return { sent: false, reason: "no_api_key" };
  if (!recipientE164) return { sent: false, reason: "no_recipient" };

  // 1. Tenant SMS settings + owner number. Bail before claiming the dedup key
  //    when we can't send, so a misconfigured tenant can be retried later.
  let settings: {
    forward_to_e164?: string | null;
    telnyx_sms_from_e164?: string | null;
    telnyx_messaging_profile_id?: string | null;
  } | null = null;
  try {
    const { data } = await supabase
      .from("business_telnyx_settings")
      .select("forward_to_e164, telnyx_sms_from_e164, telnyx_messaging_profile_id")
      .eq("business_id", businessId)
      .maybeSingle();
    settings = data ?? null;
  } catch {
    return { sent: false, reason: "settings_error" };
  }
  const ownerE164 = normE164(settings?.forward_to_e164);
  const fromE164 = normE164(settings?.telnyx_sms_from_e164);
  const messagingProfileId = normE164(settings?.telnyx_messaging_profile_id);
  // telnyxSendSms requires a messaging profile (the `from` may be picked from
  // the profile's number pool). No profile ⇒ we can't send.
  if (!messagingProfileId) return { sent: false, reason: "no_sms_sender" };

  // 2. Dedup claim — only the first writer proceeds to send.
  const { error: claimErr } = await supabase
    .from("voice_transfer_notifications")
    .insert({ dedupe_key: dedupeKey, business_id: businessId, outcome });
  if (claimErr) {
    const code = (claimErr as { code?: string }).code;
    return { sent: false, reason: code === "23505" ? "duplicate" : "claim_error" };
  }

  // 3. Resolve display names.
  const callerName = await lookupContactName(supabase, businessId, callerE164);
  const recipName = recipientIsOwner(recipientE164, ownerE164)
    ? await lookupOwnerName(supabase, businessId)
    : await lookupTeamName(supabase, businessId, recipientE164);
  const callerLabel = labelFor(callerName, callerE164, "the caller");
  const recipientLabel = labelFor(recipName, recipientE164, "your teammate");

  // 4. Recipient SMS.
  try {
    await telnyxSendSms({
      apiKey,
      messagingProfileId,
      fromE164: fromE164 || undefined,
      toE164: recipientE164,
      text: buildRecipientMessage(outcome, callerLabel)
    });
  } catch (err) {
    console.error("warm-transfer notify: recipient SMS threw", err);
  }

  // 5. Owner copy when the recipient isn't the owner.
  if (shouldNotifyOwner(recipientE164, ownerE164)) {
    try {
      await telnyxSendSms({
        apiKey,
        messagingProfileId,
        fromE164: fromE164 || undefined,
        toE164: ownerE164,
        text: buildOwnerMessage(outcome, recipientLabel, callerLabel)
      });
    } catch (err) {
      console.error("warm-transfer notify: owner SMS threw", err);
    }
  }

  return { sent: true };
}
