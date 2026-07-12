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
