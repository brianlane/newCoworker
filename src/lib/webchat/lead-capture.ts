/**
 * `webchat_capture_lead` core — the ONLY write tool on the widget surface.
 *
 * Records visitor contact details + interest as a `coworker_logs` row (so
 * the lead shows up in the owner's activity feed immediately) and merges
 * the details onto the widget session row (so the owner's Web chat list
 * shows who the conversation was with, and the pre-chat-form and
 * mid-conversation capture paths converge on the same columns).
 *
 * Session attribution: the Rowboat tool webhook carries NO caller context,
 * so the prompt gives the model an opaque `sessionRef` (the session UUID)
 * to pass back verbatim. We validate it resolves to a session of the SAME
 * business before writing — a hallucinated/injected ref can at worst tag a
 * sibling session of the same tenant, never cross a tenant boundary, and
 * an invalid ref still records the lead log (attribution is best-effort,
 * the lead itself is not).
 */

import { randomUUID } from "crypto";
import { insertCoworkerLog } from "@/lib/db/logs";
import {
  getWebchatSessionById,
  updateWebchatSessionContact
} from "@/lib/webchat/db";
import { ensureCapturedContact } from "@/lib/customer-memory/capture-contact";
import { coerceOwnerPhoneToE164 } from "@/lib/telnyx/assign-did";
import { logger } from "@/lib/logger";

export type CaptureWebchatLeadArgs = {
  name?: string;
  phone?: string;
  email?: string;
  /** What the visitor wants — service, question, timeline. */
  interest?: string;
  notes?: string;
  /** Opaque session UUID from the system prompt; validated, best-effort. */
  sessionRef?: string;
};

export type CaptureWebchatLeadResult =
  | { ok: true; data: { logId: string } }
  | { ok: false; detail: string; message?: string };

/**
 * Guidance fed back to the model when a capture carries no way to reach
 * the visitor. Explicit "nothing was saved" so the model can't tell the
 * visitor their details were captured (observed in production: visitor
 * said "go ahead and capture my details" without ever sharing any, the
 * interest-only capture succeeded, and the assistant claimed success).
 */
export const WEBCHAT_CAPTURE_NO_CONTACT_MESSAGE =
  "Nothing was saved: there is no phone number or email for this visitor, so the team " +
  "has no way to reach them. Ask for a phone number or email address, then call this " +
  "tool again with it. Do NOT tell the visitor their details were captured.";

export async function captureWebchatLead(
  businessId: string,
  args: CaptureWebchatLeadArgs
): Promise<CaptureWebchatLeadResult> {
  const name = args.name?.trim() || null;
  const phone = args.phone?.trim() || null;
  const email = args.email?.trim() || null;
  const interest = args.interest?.trim() || null;
  const notes = args.notes?.trim() || null;

  // Require something actionable so the log isn't empty noise.
  if (!name && !phone && !email && !interest && !notes) {
    return { ok: false, detail: "empty_capture" };
  }

  // Resolve the session ref FIRST so the log can carry the attribution.
  // Cross-tenant refs are dropped (business_id mismatch), invalid refs are
  // ignored — the lead log below is written either way.
  let sessionId: string | null = null;
  let sessionHasContact = false;
  const ref = args.sessionRef?.trim();
  if (ref && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
    try {
      const session = await getWebchatSessionById(ref);
      if (session && session.business_id === businessId) {
        sessionId = session.id;
        sessionHasContact = Boolean(
          session.visitor_email?.trim() || session.visitor_phone?.trim()
        );
      }
    } catch (err) {
      logger.warn("webchat lead-capture: session lookup failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // A lead the team cannot REACH is not a lead. Refuse unless this call
  // (or the session's pre-chat form / an earlier capture) provided a phone
  // or email — a name or interest alone gives the team nobody to contact.
  // Interest-only captures stay allowed for sessions whose contact is
  // already on file (they enrich a reachable lead).
  if (!phone && !email && !sessionHasContact) {
    return {
      ok: false,
      detail: "no_contact_details",
      message: WEBCHAT_CAPTURE_NO_CONTACT_MESSAGE
    };
  }

  const logId = randomUUID();
  await insertCoworkerLog({
    id: logId,
    business_id: businessId,
    task_type: "webchat",
    status: "success",
    log_payload: {
      source: "webchat_capture_lead",
      visitorName: name,
      visitorPhone: phone,
      visitorEmail: email,
      interest,
      notes,
      sessionId
    }
  });

  // Best-effort session merge — the lead is already durably logged above,
  // so attribution/link failures degrade silently rather than failing the
  // tool call mid-conversation.
  if (sessionId) {
    try {
      await updateWebchatSessionContact(sessionId, { name, email, phone });
    } catch (err) {
      logger.warn("webchat lead-capture: session contact merge failed", {
        businessId,
        sessionId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // Cross-channel contact rollup: a visitor who left a usable phone number
  // becomes (or bumps) a contact profile with last_channel='webchat', the
  // same way a texter or caller would — so the owner's Contacts page shows
  // web leads alongside everyone else, the email links to the same profile,
  // and a brand-new lead fires the `contact_created` AiFlow trigger.
  // Best-effort inside ensureCapturedContact, like the merges above.
  const e164 = coerceOwnerPhoneToE164(phone);
  if (e164) {
    await ensureCapturedContact(businessId, {
      e164,
      name,
      email,
      channel: "webchat"
    });
  }

  return { ok: true, data: { logId } };
}
