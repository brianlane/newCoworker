/**
 * Curated, code-defined AiFlow templates the dashboard installs with one
 * click (distinct from the ai_flow_library catalog, which is aggregated from
 * real tenant flows and pruned hourly — a curated starter would be deleted by
 * that refresh, so it lives here in code instead).
 *
 * Every template must pass `parseAiFlowDefinition` — enforced by unit test —
 * so the install path (POST /api/aiflows) can never 400 on our own template.
 */
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

export type AiFlowTemplate = {
  /** Stable key (used by install callers and analytics). */
  key: string;
  /** Flow name the install creates. */
  name: string;
  definition: AiFlowDefinition;
};

/**
 * "Meta lead follow-up": the starter flow the Meta-leads How-To guide
 * installs. A webhook event (a lead forwarded by Zapier/Make from a Meta
 * Lead Ads form) is parsed with Gemini extraction, filed as a customer,
 * texted back within seconds, and summarized to the owner. Installed
 * DISABLED so the owner reviews the SMS wording before anything fires.
 */
export function metaLeadFollowUpTemplate(): AiFlowTemplate {
  return {
    key: "meta_lead_follow_up",
    name: "Meta lead follow-up",
    definition: {
      version: 1,
      trigger: { channel: "webhook", conditions: [] },
      steps: [
        {
          id: "s_extract",
          type: "extract_text",
          fields: [
            { name: "lead_name", description: "The lead's full name" },
            {
              name: "lead_phone",
              description: "The lead's phone number, digits and + only"
            },
            { name: "lead_email", description: "The lead's email address" },
            {
              name: "lead_notes",
              description:
                "Everything else the lead provided: custom question answers, city, budget, timeframe. 'none' if nothing."
            }
          ]
        },
        {
          id: "s_file",
          type: "upsert_customer",
          phoneVar: "lead_phone",
          nameVar: "lead_name",
          emailVar: "lead_email"
        },
        {
          id: "s_text_lead",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          body:
            "Hi {{vars.lead_name}}, thanks for your interest! I got your note and " +
            "I'm on it — what's the best time to give you a quick call?"
        },
        {
          id: "s_notify_owner",
          type: "notify_owner",
          message:
            "New Meta ad lead: {{vars.lead_name}} — {{vars.lead_phone}} / " +
            "{{vars.lead_email}}. Details: {{vars.lead_notes}}. I texted them a hello; " +
            "they're filed in your customers."
        }
      ]
    }
  };
}

/** Review links ride inside an SMS body (1600-char cap); keep them sane. */
export const REVIEW_LINK_MAX_LENGTH = 300;

/**
 * Normalize an owner-pasted review link for embedding in the template's SMS
 * body: trims, requires http(s), strips `{`/`}` so a pasted value can never
 * smuggle a `{{vars.x}}` reference into the flow (an unknown var would fail
 * validation and 400 the install), and caps the length. Returns null when
 * the value isn't usable as a link.
 */
export function cleanReviewLink(raw: string): string | null {
  const link = raw.trim().replace(/[{}]/g, "");
  if (link.length === 0 || link.length > REVIEW_LINK_MAX_LENGTH) return null;
  if (!/^https?:\/\/\S+$/i.test(link)) return null;
  return link;
}

/**
 * "Ask for a review after appointments" (the GHL Reviews-AI answer, minus
 * the platform lock-in): when a calendar appointment ENDS (plus a settle-in
 * hour), read the customer's name + phone off the event, text them the
 * business's review link, and brief the owner. Parameterized on the review
 * link because it's per-business — the installer passes the owner's pasted
 * Google (or Yelp/Facebook) review URL, pre-cleaned by cleanReviewLink.
 * Installed DISABLED so the owner reviews the wording before anything fires.
 *
 * The send skips gracefully when the event carries no usable phone (the
 * send_sms planner's empty-recipient skip), so all-day blocks and internal
 * meetings never text anyone.
 */
export function reviewRequestTemplate(reviewLink: string): AiFlowTemplate {
  return {
    key: "review_request_after_appointment",
    name: "Ask for a review after appointments",
    definition: {
      version: 1,
      trigger: {
        channel: "calendar",
        on: "event_end",
        followMinutes: 60,
        calendar: "both",
        conditions: []
      },
      steps: [
        {
          id: "s_extract",
          type: "extract_text",
          fields: [
            {
              name: "customer_name",
              description:
                "The customer/attendee's first name (not the business owner or organizer). 'there' if unknown."
            },
            {
              name: "customer_phone",
              description:
                "The customer's phone number, digits and + only. 'none' if the event has no customer phone."
            }
          ]
        },
        {
          id: "s_text_review",
          type: "send_sms",
          to: "{{vars.customer_phone}}",
          body:
            "Hi {{vars.customer_name}}, thanks for coming in today! If you had a " +
            "good experience, would you mind leaving us a quick review? It really " +
            `helps: ${reviewLink}`
        },
        {
          id: "s_notify_owner",
          type: "notify_owner",
          // {{vars.actions_taken}} is the engine's truthful ledger of what
          // actually went out: "texted +1602… " on a send, "skipped a text
          // to 'TBD' …" when the extracted phone wasn't usable — so this
          // brief can never claim a text that the send step skipped.
          message:
            "Appointment \u201c{{trigger.event_title}}\u201d wrapped up. Review " +
            "request for {{vars.customer_name}}: {{vars.actions_taken}}",
          when: { var: "customer_phone", notEquals: "none" }
        }
      ]
    }
  };
}

/**
 * "Confirm document receipt": when the AI coworker's own mailbox receives
 * an email carrying attachments, email the sender a receipt confirmation
 * (naming the files) and brief the owner. The trigger is a regex anchored
 * to the `[inbound attachments] …` line the inbound path appends to the
 * very END of windowText — a mail with no attachments never fires it, and
 * prose that merely says "attachments:" can't false-positive. Installed
 * DISABLED so the owner reviews the wording (and their connected sending
 * mailbox) first.
 *
 * No parameters: {{trigger.attachments}} carries the filenames and
 * {{trigger.from}} the sender, both supplied by the tenant_email scope.
 */
export function documentReceiptTemplate(): AiFlowTemplate {
  return {
    key: "document_receipt_confirmation",
    name: "Confirm document receipt",
    definition: {
      version: 1,
      trigger: {
        channel: "tenant_email",
        // Anchored to the end of windowText, where the inbound path appends
        // the marker line (see EMAIL_ATTACHMENTS_MARKER in trigger-eval).
        conditions: [{ type: "regex", value: "\\n\\[inbound attachments\\] .+$" }]
      },
      steps: [
        {
          id: "s_confirm",
          type: "send_email",
          to: "{{trigger.from}}",
          subject: "We received your documents",
          body:
            "Hi,\n\nJust confirming we received your file(s): {{trigger.attachments}}.\n\n" +
            "Our team will review them and follow up if anything else is needed.\n\nThank you!"
        },
        {
          id: "s_notify_owner",
          type: "notify_owner",
          message:
            "Documents received from {{trigger.from}}: {{trigger.attachments}}. " +
            "I emailed them a receipt confirmation — the files are on your Emails page."
        }
      ]
    }
  };
}

/**
 * "Send new leads your price sheet": when a new lead texts in, extract their
 * details, file them, text them the chosen document as an expiring link, and
 * wait for the reply. Parameterized on the document because documents are
 * per-business — the installer passes the owner's picked doc (id + title),
 * and the save-time validator refuses anything that isn't a real, ready,
 * client-facing document of theirs.
 */
export function priceSheetShareTemplate(documentId: string, documentTitle: string): AiFlowTemplate {
  return {
    key: "price_sheet_share",
    name: "Send new leads your price sheet",
    definition: {
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        {
          id: "s_share",
          type: "share_document",
          documentId,
          documentTitle,
          to: "{{trigger.from}}",
          via: "sms",
          messageTemplate: "Thanks for reaching out! Here it is: {{share_url}}",
          saveAs: "shared_doc_url"
        },
        {
          id: "s_notify_owner",
          type: "notify_owner",
          message:
            "A new texter ({{trigger.from}}) asked about your services — I texted them " +
            "the document. Link I shared: {{vars.shared_doc_url}}"
        }
      ]
    }
  };
}
