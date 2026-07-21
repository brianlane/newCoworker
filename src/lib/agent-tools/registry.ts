/**
 * Catalog of coworker surfaces ("workers") and the tools each one can use.
 *
 * This is the single source of truth for the Settings → Coworker tools page
 * and for every enforcement point (dashboard-chat enqueue route, the VPS
 * chat-worker's email adapter, and the /api/voice/tools/* adapters). The
 * owner's per-tool overrides live in the `agent_tool_settings` table
 * (supabase/migrations/20260611000000_agent_tool_settings.sql); a missing row
 * means "use `defaultEnabled` from this registry".
 *
 * `configurable: false` marks tools we surface for visibility but cannot
 * toggle from the platform (no platform-side chokepoint), so flipping a row
 * here would be a lie. The API route refuses writes for them.
 *
 * Rowboat-mediated tools (texting coworker + the dashboard coworker's
 * Rowboat-declared tools) execute through /api/rowboat/tool-call — the
 * per-tenant Rowboat project's tool webhook — which enforces these settings
 * per call, so they ARE configurable.
 */

export type AgentKey = "dashboard" | "voice" | "sms" | "webchat";

export type AgentToolDefinition = {
  toolKey: string;
  label: string;
  description: string;
  /** Effective state when the owner has never toggled this tool. */
  defaultEnabled: boolean;
  /** False ⇒ display-only (no platform enforcement point); writes rejected. */
  configurable: boolean;
};

export type AgentDefinition = {
  key: AgentKey;
  label: string;
  description: string;
  tools: AgentToolDefinition[];
};

export const AGENT_TOOL_REGISTRY: AgentDefinition[] = [
  {
    key: "dashboard",
    label: "Dashboard chat coworker",
    description:
      "Your private assistant on /dashboard/chat. Summarizes customer activity and answers business questions.",
    tools: [
      {
        toolKey: "send_email",
        label: "Send email",
        description:
          "Send an email from your connected mailbox (Integrations → Workspace) when you ask for it in chat.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "send_sms",
        label: "Send text message",
        description:
          "Text any number from your business line when you ask for it in chat.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "send_whatsapp",
        label: "Send WhatsApp message",
        description:
          "Message any number from your connected WhatsApp Business account when you ask for it in chat (requires the WhatsApp integration).",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "memory_capture",
        label: "Business memory capture",
        description:
          "Automatically save durable business rules you state in chat to your coworker's memory.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "generate_image",
        label: "Generate images",
        description:
          "Create an AI-generated image — or edit a photo you attach — in chat when you explicitly ask for one (limited per conversation; Standard allows more; uses your AI budget).",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "business_knowledge_lookup",
        label: "Business knowledge lookup",
        description: "Answer your questions from your business knowledge and website summary.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "run_aiflow",
        label: "Run automations",
        description:
          "List your AiFlows in chat and run an enabled one when you ask (it will offer the automation when one matches your request).",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "edit_aiflow",
        label: "Edit automations",
        description:
          "Change an existing AiFlow from chat (or by texting your coworker) — small tweaks or full edits, applied in place after you confirm the exact changes. Every edit is validated before it's saved.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_find_slots",
        label: "Find calendar openings",
        description: "Look up free slots on your connected calendar from chat.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_book_appointment",
        label: "Book appointments",
        description: "Book appointments on your connected calendar from chat.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_reschedule_appointment",
        label: "Reschedule appointments",
        description:
          "Move an existing appointment to a new time from chat — the invitation is updated in place, never duplicated.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_cancel_appointment",
        label: "Cancel appointments",
        description:
          "Cancel an existing appointment from chat — the attendee gets a single cancellation notice.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "customer_lookup_by_phone",
        label: "Recognize repeat customers",
        description: "Look up a customer's cross-channel history when you ask about them in chat.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "customer_set_display_name",
        label: "Save customer names",
        description: "Save a customer's name to their profile from chat.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "customer_append_pinned_note",
        label: "Pin customer notes",
        description: "Pin permanent facts (preferences, constraints) to a customer's profile from chat.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "document_list",
        label: "List documents",
        description: "List your uploaded business documents (title, audience, expiration) in chat.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "document_share",
        label: "Share documents",
        description:
          "Create an expiring share link for any of your documents and text/email it when you ask.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "document_update",
        label: "Edit documents",
        description:
          "Apply your plain-language edits (\"haircuts are now $40\") to a document's knowledge content. Dashboard only — customers can never change your documents.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "document_set_expiration",
        label: "Set document expiration",
        description:
          "Set, extend, or clear a document's expiration date from chat. Expired documents stop being quoted or shared.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "document_request_signature",
        label: "Request signatures",
        description:
          "Send a document for a legal e-signature when you ask: the signer gets a link, types their name to sign, and you're notified with a full audit record. Dashboard only — sending contracts is always your call.",
        defaultEnabled: true,
        configurable: true
      }
    ]
  },
  {
    key: "voice",
    label: "Phone coworker",
    description: "Answers your business line and handles caller requests with these tools.",
    tools: [
      {
        toolKey: "business_knowledge_lookup",
        label: "Business knowledge lookup",
        description: "Answer caller questions from your business knowledge and website summary.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_find_slots",
        label: "Find calendar openings",
        description: "Look up free slots on your connected calendar.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_book_appointment",
        label: "Book appointments",
        description: "Book appointments on your connected calendar.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "send_follow_up_email",
        label: "Send follow-up email",
        description: "Email a short follow-up to a caller from your connected mailbox.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "send_follow_up_sms",
        label: "Send follow-up text",
        description: "Text a follow-up to a caller from your business number.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "capture_caller_details",
        label: "Capture caller details",
        description: "Record caller name, contact info, and intent for your dashboard.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "notify_team",
        label: "Notify your team",
        description:
          "Alert you (dashboard, email, or text per your notification settings) when a caller needs something only your team can resolve.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "customer_lookup_by_phone",
        label: "Recognize repeat customers",
        description: "Look up the caller's cross-channel history so they're greeted as a known customer.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "customer_set_display_name",
        label: "Save customer names",
        description: "Remember a caller's name on their customer profile.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "customer_append_pinned_note",
        label: "Pin customer notes",
        description: "Pin permanent facts (preferences, constraints) to a customer's profile.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "document_share",
        label: "Share documents",
        description:
          "Text a caller an expiring link to a client-facing document (price sheet, policy, contract) when they ask for it.",
        defaultEnabled: true,
        configurable: true
      }
    ]
  },
  {
    key: "sms",
    label: "Texting coworker",
    description: "Replies to inbound customer texts on your business number.",
    tools: [
      {
        toolKey: "business_knowledge_lookup",
        label: "Business knowledge lookup",
        description: "Answer texter questions from your business knowledge and website summary.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_find_slots",
        label: "Find calendar openings",
        description: "Look up free slots on your connected calendar for a texter.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_book_appointment",
        label: "Book appointments",
        description: "Book appointments on your connected calendar for a texter.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_reschedule_appointment",
        label: "Reschedule appointments",
        description:
          "Move a texter's existing appointment to a new time — the invitation is updated in place, never duplicated.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_cancel_appointment",
        label: "Cancel appointments",
        description:
          "Cancel a texter's existing appointment — they get a single cancellation notice.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "send_email",
        label: "Send follow-up email",
        description: "Email a follow-up to a texter from your connected mailbox.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "notify_team",
        label: "Notify your team",
        description:
          "Alert you (dashboard, email, or text per your notification settings) when a texter needs something only your team can resolve.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "generate_image",
        label: "Generate images",
        description:
          "Text an AI-generated image (MMS) — or edit a photo the texter sends — when they explicitly ask for one (limited per conversation; Standard allows more; uses your AI budget).",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "customer_lookup_by_phone",
        label: "Recognize repeat customers",
        description:
          "Look up a texter's cross-channel history so they're greeted as a known customer.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "customer_set_display_name",
        label: "Save customer names",
        description: "Remember a texter's name on their customer profile.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "customer_append_pinned_note",
        label: "Pin customer notes",
        description:
          "Pin permanent facts (preferences, constraints) to a customer's profile.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "document_share",
        label: "Share documents",
        description:
          "Text a customer an expiring link to a client-facing document (price sheet, policy, contract) when they ask for it.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "start_aiflow_for_contact",
        label: "Start automations for a texter",
        description:
          "Enroll the customer it's texting with into an AiFlow you've marked \"texting coworker may enroll customers\" (per-flow checkbox; nothing else is visible to it). Never re-enrolls someone already in the flow.",
        defaultEnabled: true,
        configurable: true
      }
    ]
  },
  {
    // Website chat widget (Standard+). DELIBERATELY the smallest tool
    // surface of any coworker: it faces the anonymous internet, so it is
    // info + lead gen ONLY — no SMS sends, no email sends, no calls, no
    // image generation. This list is enforced structurally: the Rowboat
    // workflow seed declares only `webchat_*` tool names for the
    // WebchatCoworker agents, and /api/rowboat/tool-call maps those names
    // exclusively to the entries below (unknown names fail closed). Do NOT
    // add side-effect tools here without revisiting that threat model.
    key: "webchat",
    label: "Website chat coworker",
    description:
      "Answers visitors on the chat widget embedded in your own website. Info and lead capture only.",
    tools: [
      {
        toolKey: "business_knowledge_lookup",
        label: "Business knowledge lookup",
        description:
          "Answer visitor questions from your business knowledge and website summary.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "capture_lead",
        label: "Capture lead details",
        description:
          "Record a visitor's name, phone, email, and what they're looking for so you can follow up.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_find_slots",
        label: "Find calendar openings",
        description: "Look up free slots on your connected calendar for a website visitor.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_book_appointment",
        label: "Book appointments",
        description: "Book appointments on your connected calendar for a website visitor.",
        defaultEnabled: true,
        configurable: true
      },
      {
        // Webchat sharing is INLINE-ONLY (the link appears in the chat) —
        // no SMS/email sends from the anonymous surface, preserving the
        // info + lead-gen threat model.
        toolKey: "document_share",
        label: "Share documents",
        description:
          "Give a website visitor an expiring link to a client-facing document (price sheet, policy, contract) right in the chat.",
        defaultEnabled: true,
        configurable: true
      }
    ]
  }
];

export function findAgentToolDefinition(
  agentKey: string,
  toolKey: string
): { agent: AgentDefinition; tool: AgentToolDefinition } | null {
  const agent = AGENT_TOOL_REGISTRY.find((a) => a.key === agentKey);
  if (!agent) return null;
  const tool = agent.tools.find((t) => t.toolKey === toolKey);
  if (!tool) return null;
  return { agent, tool };
}
