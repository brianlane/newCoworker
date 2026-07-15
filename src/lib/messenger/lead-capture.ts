/**
 * Messenger/Instagram variant of `webchat_capture_lead` — the write tool
 * on the DM conversation surface.
 *
 * Records the lead's contact details + interest as a `coworker_logs` row
 * (owner activity feed), merges name/phone onto the conversation row (the
 * Messenger inbox shows who it was, and a captured phone unlocks SMS
 * follow-ups outside Meta's 24h window), and rolls a usable phone up to
 * the cross-channel contact profile with last_channel='messenger'.
 *
 * Attribution: the engine's system prompt hands the model an opaque
 * `sessionRef` (the conversation UUID) to pass back verbatim — validated
 * against the SAME business before writing, so a hallucinated ref can at
 * worst tag a sibling conversation of the same tenant, never cross a
 * tenant boundary. The lead log itself is written either way (webchat
 * lead-capture semantics).
 */

import { randomUUID } from "crypto";
import { insertCoworkerLog } from "@/lib/db/logs";
import {
  getMessengerConversationById,
  updateMessengerConversationContact
} from "@/lib/messenger/db";
import {
  linkCustomerEmail,
  recordInteractionAndIncrement
} from "@/lib/customer-memory/db";
import { coerceOwnerPhoneToE164 } from "@/lib/telnyx/assign-did";
import { logger } from "@/lib/logger";

export type CaptureMessengerLeadArgs = {
  name?: string;
  phone?: string;
  email?: string;
  interest?: string;
  notes?: string;
  /** Opaque conversation UUID from the system prompt; validated, best-effort. */
  sessionRef?: string;
};

export type CaptureMessengerLeadResult =
  | { ok: true; data: { logId: string } }
  | { ok: false; detail: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function captureMessengerLead(
  businessId: string,
  args: CaptureMessengerLeadArgs
): Promise<CaptureMessengerLeadResult> {
  const name = args.name?.trim() || null;
  const phone = args.phone?.trim() || null;
  const email = args.email?.trim() || null;
  const interest = args.interest?.trim() || null;
  const notes = args.notes?.trim() || null;

  // Require something actionable so the log isn't empty noise.
  if (!name && !phone && !email && !interest && !notes) {
    return { ok: false, detail: "empty_capture" };
  }

  // Resolve the conversation ref FIRST so the log carries the attribution.
  // Cross-tenant refs are dropped; invalid refs are ignored.
  let conversationId: string | null = null;
  const ref = args.sessionRef?.trim();
  if (ref && UUID_RE.test(ref)) {
    try {
      const conversation = await getMessengerConversationById(ref);
      if (conversation && conversation.business_id === businessId) {
        conversationId = conversation.id;
      }
    } catch (err) {
      logger.warn("messenger lead-capture: conversation lookup failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const logId = randomUUID();
  await insertCoworkerLog({
    id: logId,
    business_id: businessId,
    task_type: "messenger",
    status: "success",
    log_payload: {
      source: "messenger_capture_lead",
      leadName: name,
      leadPhone: phone,
      leadEmail: email,
      interest,
      notes,
      conversationId
    }
  });

  // Best-effort conversation merge — the lead is durably logged above.
  if (conversationId) {
    try {
      await updateMessengerConversationContact(conversationId, { name, phone });
    } catch (err) {
      logger.warn("messenger lead-capture: conversation contact merge failed", {
        businessId,
        conversationId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // Cross-channel contact rollup: a usable phone number becomes (or bumps)
  // a contact profile with last_channel='messenger' — from then on SMS
  // follow-ups work outside the 24h window. Best-effort, like webchat.
  const e164 = coerceOwnerPhoneToE164(phone);
  if (e164) {
    try {
      await recordInteractionAndIncrement(businessId, e164, "messenger", {
        displayName: name
      });
    } catch (err) {
      logger.warn("messenger lead-capture: contact rollup failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    if (email) {
      try {
        await linkCustomerEmail(businessId, e164, email);
      } catch (err) {
        logger.warn("messenger lead-capture: linkCustomerEmail failed", {
          businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  return { ok: true, data: { logId } };
}
