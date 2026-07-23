/**
 * Pure helpers for warm-transfer SMS notifications.
 *
 * On every voice warm transfer we text the recipient (and, when the recipient
 * isn't the tenant owner, the owner too) with the outcome + caller identity.
 * Detection happens on the Telnyx webhook side: `call.bridged` on a transfer
 * leg = a human answered (success); `call.hangup` with no prior bridge =
 * no-answer (failure).
 *
 * These branch-free helpers (client_state encode/parse, label + message
 * builders, owner comparisons) are isolated here so the Vitest suite can import
 * them directly. The impure sender (Supabase name resolution + Telnyx send)
 * lives in telnyx-voice-call-end, which owns the webhook lifecycle. This file
 * must stay dependency-free (btoa/atob only).
 */

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

/** Trim to a comparable E.164 (nullish → ""). */
export function normE164(e164: string | null | undefined): string {
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
  if (!owner) return false;
  return owner !== normE164(recipientE164);
}

/** True when the transfer recipient IS the tenant owner. */
export function recipientIsOwner(
  recipientE164: string | null | undefined,
  ownerE164: string | null | undefined
): boolean {
  const owner = normE164(ownerE164);
  return owner !== "" && owner === normE164(recipientE164);
}

export function buildRecipientMessage(outcome: WtOutcome, callerLabel: string): string {
  return outcome === "success"
    ? `Warm transfer successful for ${callerLabel}.`
    : `Missed warm transfer for ${callerLabel}, please follow up.`;
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
