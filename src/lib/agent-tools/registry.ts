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

export type AgentKey = "dashboard" | "voice" | "sms";

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
          "Create an AI-generated image in chat when you explicitly ask for one (limit 3 per conversation; uses your AI budget).",
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
        toolKey: "send_email",
        label: "Send follow-up email",
        description: "Email a follow-up to a texter from your connected mailbox.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "generate_image",
        label: "Generate images",
        description:
          "Text an AI-generated image (MMS) when a texter explicitly asks for one (limit 3 per conversation; uses your AI budget).",
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
