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
 * Rowboat-declared tools) execute through /api/rowboat/tool-call, the
 * per-tenant Rowboat project's tool webhook, which enforces these settings
 * per call, so they ARE configurable.
 */

export type AgentKey = "dashboard" | "voice" | "sms" | "webchat" | "email" | "slack";

export type AgentToolDefinition = {
  toolKey: string;
  label: string;
  description: string;
  /** Effective state when the owner has never toggled this tool. */
  defaultEnabled: boolean;
  /** False ⇒ display-only (no platform enforcement point); writes rejected. */
  configurable: boolean;
  /**
   * Platform-only: New Coworker's own tooling, not a tenant capability.
   *
   * These are filtered out of everything a tenant can see or reach
   * (`resolveAgentTools`, which renders Settings → Coworker tools, and the
   * `manage_coworker_tools` MCP surface), and their handlers additionally
   * refuse for any business other than HQ. A tenant selling dentistry has no
   * use for a New Coworker signup checkout link, and showing them a toggle
   * they cannot use would be noise at best and confusing at worst.
   *
   * The registry entry still exists because the dispatch allowlist
   * (`TOOL_GATES`) resolves its toggle from here, and the seed-parity test
   * asserts registry ↔ seed ↔ gates lockstep.
   */
  platformOnly?: boolean;
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
          "Create an AI-generated image, or edit a photo you attach, in chat when you explicitly ask for one (limited per conversation; Standard allows more; uses your AI budget).",
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
          "Change an existing AiFlow from chat (or by texting your coworker), small tweaks or full edits, applied in place after you confirm the exact changes. Every edit is validated before it's saved.",
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
          "Move an existing appointment to a new time from chat, the invitation is updated in place, never duplicated.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_cancel_appointment",
        label: "Cancel appointments",
        description:
          "Cancel an existing appointment from chat, the attendee gets a single cancellation notice.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_join_waitlist",
        label: "Cancellation waitlist",
        description:
          "Put a customer on the waitlist from chat: when a cancellation frees an earlier slot, they get one text offering it.",
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
          "Apply your plain-language edits (\"haircuts are now $40\") to a document's knowledge content. Dashboard only, customers can never change your documents.",
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
          "Send a document for a legal e-signature when you ask: the signer gets a link, types their name to sign, and you're notified with a full audit record. Dashboard only, sending contracts is always your call.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "update_notification_preferences",
        label: "Change notification settings",
        description:
          "Turn your alert toggles on or off when you ask in chat (e.g. client reply alerts). Managers and owners only; it can never change your alert phone or email.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "flag_contact_spam",
        label: "Flag spam contacts",
        description:
          "When you declare a lead or contact spam in chat (or by texting your coworker), block their number from all texting, stop their pending automations, and tag the contact. Managers and owners only; the block lifts only if the contact texts START.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "set_contact_reply_mode",
        label: "Stop or resume texting a contact",
        description:
          "When you ask your coworker (in chat or by text) to stop texting a specific contact, it turns off its automatic replies to them and stops their pending automations, you can still text them yourself, and asking to resume turns replies back on.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "manage_employee",
        label: "Manage your employee roster",
        description:
          "Add a teammate, change their number, hours, or name, deactivate them, and turn any of their four lead-availability switches on or off when you ask in chat (or by texting your coworker). Managers and owners only; every change is also visible and reversible on the Employees page.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "custom_table_read",
        label: "Read your own tables",
        description:
          "Let your coworker look inside the tables you built yourself (the Tables page): what columns they have, what is in them, and what changed recently. Read-only.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "custom_table_write",
        label: "Fill in your own tables",
        description:
          "Add, change, and delete ROWS in the tables you built yourself when you ask in chat, and undo any of it. Deleting a row asks you first, and every change can be put back from Recent changes.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "custom_table_manage",
        label: "Build and change your own tables",
        description:
          "Create a new table, add or rename a column, and delete a whole table when you ask in chat. Deleting asks you first and the table comes back for 30 days. Managers and owners only.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "read_business_data",
        label: "Business data reads",
        description:
          "Let your coworker look things up to answer you: contacts, text conversations, call transcripts, recent activity, tasks, automation details, the roster, and notification settings. Read-only.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "manage_contacts",
        label: "Add and edit contacts",
        description:
          "Create or update a contact when you ask in chat. A new or retagged contact can start its matching automations (which may message them), same as an edit on the Contacts page.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "manage_flows",
        label: "Turn automations on/off and start runs",
        description:
          "Enable or disable an automation and start one for a lead when you ask in chat. Editing an automation's steps has its own toggle (Edit automations).",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "manage_agents",
        label: "Edit document agents",
        description:
          "Update or delete a saved document agent when you ask in chat. Managers and owners only.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "update_business_profile",
        label: "Update business hours and timezone",
        description:
          "Change your weekly hours or timezone from chat, the same save as the Settings page (your coworker picks the change up right away). Managers and owners only. Phone numbers can never be changed this way.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "update_business_knowledge",
        label: "Edit coworker knowledge (owner only)",
        description:
          "Fix or add ONE section of your coworker's knowledge (services, pricing, greetings) from chat. Section-by-section edits only, never a full rewrite; owner only.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "manage_coworker_tools",
        label: "Change coworker tool settings",
        description:
          "Turn another coworker tool on or off per channel when you ask in chat (for example, stop appointment cancellations over text). Managers and owners only; the same switches as this page.",
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
        toolKey: "calendar_join_waitlist",
        label: "Cancellation waitlist",
        description:
          "Put a caller on the waitlist: when a cancellation frees an earlier slot, they get one text offering it.",
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
        toolKey: "run_aiflow",
        label: "Run automations",
        description:
          "Start one of your AiFlows from a phone call when YOU or a team member calls in (e.g. hand over a new lead and have it run your intake). Callers who are not on your team can never start one.",
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
        toolKey: "start_translator_mode",
        label: "Interpret on request (your team only)",
        description:
          "When you or a teammate calls your own line and asks for a translator, your coworker becomes a live interpreter so you can add a customer who does not share your language. Tell it the other person has hung up (or just thank it for translating) and it goes back to being your assistant. Only offered to your team's own numbers, never to customers.",
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
        toolKey: "send_signup_payment_link",
        label: "Send signup payment link",
        description:
          "Create a New Coworker checkout link for a prospect who has already filled in the signup questionnaire and is asking to pay.",
        defaultEnabled: true,
        configurable: true,
        platformOnly: true
      },
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
          "Move a texter's existing appointment to a new time, the invitation is updated in place, never duplicated.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_cancel_appointment",
        label: "Cancel appointments",
        description:
          "Cancel a texter's existing appointment, they get a single cancellation notice.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_join_waitlist",
        label: "Cancellation waitlist",
        description:
          "Put a texter on the waitlist: when a cancellation frees an earlier slot, they get one text offering it.",
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
        toolKey: "schedule_text",
        label: "Schedule a text for later",
        description:
          "Queue one text to the person being texted, to go out at a time they asked for (a reminder before their appointment, a check-in next week). It can only ever text that person, it holds one queued text at a time (scheduling again moves it), and it asks first when one of your automations already sends a reminder before appointments. Standard plan and up.",
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
          "Text an AI-generated image (MMS), or edit a photo the texter sends, when they explicitly ask for one (limited per conversation; Standard allows more; uses your AI budget).",
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
      },
      {
        toolKey: "update_notification_preferences",
        label: "Turn alerts on by text",
        description:
          "When you (or a teammate) text the assistant asking to be alerted about something, it can turn the matching alert toggle ON. Enable-only over text, turning alerts off or changing your alert phone/email is done from the dashboard.",
        defaultEnabled: true,
        configurable: true
      }
    ]
  },
  {
    // Website chat widget (Standard+). DELIBERATELY the smallest tool
    // surface of any coworker: it faces the anonymous internet, so it is
    // info + lead gen ONLY, no SMS sends, no email sends, no calls, no
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
        // Webchat sharing is INLINE-ONLY (the link appears in the chat),
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
  },
  {
    // Email coworker. NOT a Rowboat surface: it runs the inline engine
    // (src/lib/email-coworker/turn.ts), so these toggles are enforced there
    // and the tools below are the complete set it can ever hold. It answers
    // ONLY inside threads the assistant itself started, so it is exempt from
    // the Rowboat seed parity contract by construction.
    key: "email",
    label: "Email coworker",
    description:
      "Answers replies in email threads your assistant started, from your connected mailbox. Scheduling only, and only on those threads.",
    tools: [
      {
        toolKey: "business_knowledge_lookup",
        label: "Business knowledge lookup",
        description:
          "Answer a correspondent's question from your business knowledge and website summary.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_find_slots",
        label: "Find calendar openings",
        description: "Look up free slots on your connected calendar to offer by email.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_book_appointment",
        label: "Book appointments",
        description:
          "Book the appointment once the correspondent confirms a time, on the attendee's behalf when they are arranging for someone else.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_reschedule_appointment",
        label: "Reschedule appointments",
        description: "Move an existing appointment when they ask for a different time by email.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_cancel_appointment",
        label: "Cancel appointments",
        description: "Cancel an existing appointment when they ask to by email.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_join_waitlist",
        label: "Cancellation waitlist",
        description:
          "Offer to text them if an earlier slot frees up, when they ask for something sooner.",
        defaultEnabled: true,
        configurable: true
      }
    ]
  },
  {
    // Inline-engine surface like `email` (no Rowboat seed): the tenant's
    // team talks to the coworker in their connected Slack workspace. The
    // owner-power tools below additionally require the VERIFIED OWNER at
    // run time (users.info email match in src/lib/slack/worker.ts): the
    // toggle turns a tool on for the surface, never for a teammate.
    key: "slack",
    label: "Slack coworker",
    description:
      "Answers your team in your connected Slack workspace: DMs and @New Coworker mentions, with the same brain as dashboard chat.",
    tools: [
      {
        toolKey: "business_knowledge_lookup",
        label: "Business knowledge lookup",
        description: "Answer team questions from your business knowledge and website summary.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "send_sms",
        label: "Send texts",
        description: "Text a customer or teammate when someone asks in Slack.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "send_whatsapp",
        label: "Send WhatsApp messages",
        description: "Message a customer on WhatsApp when someone asks in Slack.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "send_email",
        label: "Send email (owner only)",
        description:
          "Send email from your connected mailbox when the verified owner asks in Slack.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_find_slots",
        label: "Find calendar openings",
        description: "Look up free slots on the connected calendar.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_book_appointment",
        label: "Book appointments",
        description: "Book appointments on the connected calendar.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_reschedule_appointment",
        label: "Reschedule appointments",
        description: "Move an existing appointment.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_cancel_appointment",
        label: "Cancel appointments",
        description: "Cancel an existing appointment.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "calendar_join_waitlist",
        label: "Cancellation waitlist",
        description: "Add someone to the cancellation waitlist.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "run_aiflow",
        label: "Run automations",
        description: "List and start your AiFlows from Slack.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "edit_aiflow",
        label: "Edit automations (owner only)",
        description: "Apply validated in-place AiFlow edits when the verified owner asks.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "update_notification_preferences",
        label: "Change notification settings (owner only)",
        description: "Flip alert toggles when the verified owner asks in Slack.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "flag_contact_spam",
        label: "Flag spam (owner only)",
        description: "Mark a contact as spam when the verified owner declares it.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "set_contact_reply_mode",
        label: "Mute or unmute contacts (owner only)",
        description: "Stop or resume auto-replies to one contact when the verified owner asks.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "manage_employee",
        label: "Manage the roster (owner only)",
        description: "Add or update team members when the verified owner asks.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "custom_table_read",
        label: "Read your own tables",
        description:
          "Let your coworker look inside the tables you built yourself (the Tables page): what columns they have, what is in them, and what changed recently. Read-only.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "custom_table_write",
        label: "Fill in your own tables",
        description:
          "Add, change, and delete ROWS in the tables you built yourself when you ask in chat, and undo any of it. Deleting a row asks you first, and every change can be put back from Recent changes.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "custom_table_manage",
        label: "Build and change your own tables",
        description:
          "Create a new table, add or rename a column, and delete a whole table when you ask in chat. Deleting asks you first and the table comes back for 30 days. Managers and owners only.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "read_business_data",
        label: "Business data reads",
        description:
          "Look up contacts, conversations, calls, tasks, automations, and settings to answer questions in Slack. Read-only.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "manage_contacts",
        label: "Add and edit contacts (owner only)",
        description:
          "Create or update a contact when the verified owner asks (automations may message them).",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "manage_flows",
        label: "Turn automations on/off (owner only)",
        description:
          "Enable/disable an automation or start a run when the verified owner asks.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "manage_agents",
        label: "Edit document agents (owner only)",
        description: "Update or delete a saved document agent when the verified owner asks.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "update_business_profile",
        label: "Update hours/timezone (owner only)",
        description:
          "Change weekly hours or the timezone when the verified owner asks. Never phone numbers.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "update_business_knowledge",
        label: "Edit coworker knowledge (owner only)",
        description:
          "Fix or add one knowledge section when the verified owner asks. Never a full rewrite.",
        defaultEnabled: true,
        configurable: true
      },
      {
        toolKey: "manage_coworker_tools",
        label: "Change tool settings (owner only)",
        description:
          "Turn another coworker tool on or off per channel when the verified owner asks.",
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
