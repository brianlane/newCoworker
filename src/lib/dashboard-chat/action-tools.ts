/**
 * Dashboard-chat INLINE action tools — send_sms + calendar lifecycle.
 *
 * The worker-path dashboard coworker (Rowboat `OwnerCoworker`) has had
 * `send_sms` and the `dashboard_calendar_*` tools since launch, fulfilled by
 * /api/rowboat/tool-call. When the INLINE path became primary (PR #612 /
 * #655) it shipped with only creation + knowledge tools, so a healthy inline
 * path silently REMOVED the owner's ability to text and book from chat —
 * James's (KYP Ads) test texts only worked because his turns happened to
 * fall back to the worker. This module gives the inline turn the same
 * actions through the same cores the Rowboat webhook dispatch uses.
 *
 * Design notes:
 *  - Every helper returns a plain JSON payload destined for a Gemini
 *    functionResponse — never throws (a tool blow-up must degrade to an
 *    honest failure the model can relay, not kill the turn).
 *  - send_sms mirrors the voice follow-up adapter's posture: canonicalize
 *    the destination, STOP-list check fails CLOSED, metered send, then a
 *    best-effort `sms_outbound_log` insert (source `dashboard_chat`) so the
 *    text renders in the dashboard Text history — tool sends used to be
 *    invisible platform-side (the only record lived in Telnyx).
 *  - Calendar failures carry the same model-facing guidance strings the
 *    Rowboat dispatch attaches, re-phrased for the owner surface (dashboard
 *    chat talks TO the owner; there is no notify_team here).
 */

import { z } from "zod";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { deliverWhatsApp } from "@/lib/whatsapp/deliver";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import { findCalendarSlots, bookCalendarAppointment } from "@/lib/calendar-tools/handlers";
import {
  cancelCalendarAppointment,
  rescheduleCalendarAppointment
} from "@/lib/calendar-tools/reschedule";
import { joinCalendarWaitlist } from "@/lib/calendar-tools/waitlist-join";
import { listAiFlows, enqueueAiFlowRun, updateAiFlow } from "@/lib/ai-flows/db";
import {
  undoAiFlowEditTool,
  undoAiflowToolArgsSchema
} from "@/lib/ai-flows/undo-flow-tool";
import {
  listAiFlowsTool,
  runAiFlowTool,
  runAiflowToolArgsSchema
} from "@/lib/ai-flows/manual-run-tool";
import { editAiFlowTool, editAiflowToolArgsSchema } from "@/lib/ai-flows/edit-flow-tool";
import { editAiFlowDefinition } from "@/lib/ai-flows/compile-service";
import { generateImageForDashboard, normalizeAspectRatio } from "@/lib/image-tools/handlers";
import { recordInteractionAndIncrement } from "@/lib/customer-memory/db";
import { flagContactSpam } from "@/lib/customer-tools/flag-spam";
import { setContactTextingMode } from "@/lib/customer-tools/reply-mode";
import { manageEmployee } from "@/lib/employees/manage-tool";
import {
  applyNotificationPreferenceToggles,
  NOTIFICATION_TOGGLE_KEYS
} from "@/lib/notifications/preferences-tool";
import type { GeminiFunctionDeclaration } from "@/lib/gemini-chat";
import { logger } from "@/lib/logger";

/** Tool names as declared to the inline Gemini call (base keys, no prefix). */
export const ACTION_TOOL_NAMES = [
  "send_sms",
  "send_whatsapp",
  "calendar_find_slots",
  "calendar_book_appointment",
  "calendar_reschedule_appointment",
  "calendar_cancel_appointment",
  "calendar_join_waitlist",
  "list_aiflows",
  "run_aiflow",
  "edit_aiflow",
  "undo_aiflow_edit",
  "generate_image",
  "update_notification_preferences",
  "flag_contact_spam",
  "set_contact_reply_mode",
  "manage_employee"
] as const;

export type ActionToolName = (typeof ACTION_TOOL_NAMES)[number];

export function isActionToolName(name: string): name is ActionToolName {
  return (ACTION_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Settings → Coworker tools gate state for the action tools (dashboard
 * agent). The chat route reads the toggles once per turn — same pattern as
 * `emailToolEnabled` / `knowledgeToolEnabled` — and tools that are OFF are
 * never even declared to the model. `list_aiflows` and `run_aiflow` share
 * the single `run_aiflow` Settings toggle (listing exists to serve running).
 */
export type ActionToolGates = {
  send_sms: boolean;
  send_whatsapp: boolean;
  calendar_find_slots: boolean;
  calendar_book_appointment: boolean;
  calendar_reschedule_appointment: boolean;
  calendar_cancel_appointment: boolean;
  /**
   * Cancellation waitlist: put a customer in line for an earlier slot; a
   * freed slot texts them an offer (waitlist-fill core). Same registry
   * toggle as the Rowboat dashboard_ twin.
   */
  calendar_join_waitlist: boolean;
  list_aiflows: boolean;
  run_aiflow: boolean;
  /**
   * `edit_aiflow` applies a validated in-place edit to a LIVE automation
   * (no builder-review step), so it carries its own Settings toggle ("Edit
   * automations") separate from run_aiflow.
   */
  edit_aiflow: boolean;
  /**
   * Put back the definition the last edit replaced. Shares the `edit_aiflow`
   * Settings toggle rather than carrying its own (the same way list_aiflows
   * shares run_aiflow's): a surface allowed to rewrite a live automation
   * must always be allowed to take that rewrite back, and a toggle that
   * could disable only the undo would be a footgun with no use case.
   */
  undo_aiflow_edit: boolean;
  /**
   * The dashboard `generate_image` Settings toggle. The Rowboat
   * OwnerCoworker has had `dashboard_generate_image` since the tool
   * shipped, but the INLINE primary path never declared it — so a healthy
   * inline path told owners "I don't have an image creation tool" (Truly
   * Insurance, Jul 16 2026) while only worker-fallback turns could
   * generate. Same parity gap this module exists to close for send_sms.
   */
  generate_image: boolean;
  /**
   * Settings toggle AND the caller's manage_settings role (manager+),
   * computed per turn by the chat route — a staff-role teammate never even
   * sees this tool declared. INLINE-ONLY by design: the Rowboat fallback
   * carries no caller role, so it gets no dashboard_ twin.
   */
  update_notification_preferences: boolean;
  /**
   * Owner declared a lead spam: opt-out suppression + pending-run cancels +
   * contact tag through the shared core (customer-tools/flag-spam.ts).
   * INLINE-ONLY by design — declared solely on the owner-verified surfaces
   * (dashboard chat, owner-SMS operator turn); the customer-facing Rowboat
   * texting coworker must never hold an irreversible suppression tool. On
   * dashboard chat the gate also requires the caller's manage_settings role
   * (same bar as /api/dashboard/sms-optouts — the suppression cannot be
   * undone from the platform); the owner-SMS surface is the verified owner.
   */
  flag_contact_spam: boolean;
  /**
   * "Stop texting X" / "resume texting X": sms_reply_mode suppress/auto +
   * pending-run cancels through the shared core
   * (customer-tools/reply-mode.ts). The REVERSIBLE sibling of
   * flag_contact_spam, added after the Chris Gregoris incident (Jul 24
   * 2026) where the spam block was the only tool that could stop
   * follow-ups. Inline-only like the other contact tools; needs no
   * manage_settings (the dashboard thread's reply-mode toggle is
   * operate_messages-level).
   */
  set_contact_reply_mode: boolean;
  /**
   * Roster CRUD: add a teammate, edit them, deactivate them, and set the
   * three lead-availability switches. Inline-only on verified owner surfaces
   * (dashboard chat, owner-SMS operator turn) plus MCP; the customer-facing
   * texting coworker must never be able to put someone on the roster that
   * receives leads. On dashboard chat the gate also requires manage_settings,
   * the same bar the Employees page itself enforces.
   */
  manage_employee: boolean;
};

// Every clock time in an outbound body carries a named timezone (KYP/Ayanna
// Jul 20 2026: a "3:00 PM" confirmation with no timezone went to a
// Central-time lead about an Eastern-time call — a plausible no-show cause).
const OUTBOUND_TIMEZONE_RULE =
  ' If the body mentions a clock time, always name the timezone (e.g. "1:00 PM Eastern", never a bare "1:00 PM"), and when the recipient is known to be in a different timezone, give the time in THEIR timezone too.';

// Outbound-first recipients must exist as contacts (KYP/Ayanna: a number the
// owner texted twice had no contact row, so the assistant later denied any
// record of her). Optional — the send never depends on it.
const CONTACT_NAME_PARAM = {
  type: "string",
  description:
    "The recipient's name, when the owner mentioned one, files them as a contact so the send is never to an invisible number. An existing contact's name is never overwritten."
} as const;

const SEND_SMS_DECLARATION: GeminiFunctionDeclaration = {
  name: "send_sms",
  description:
    "Send a text message from the business number to any phone number. Use ONLY when the owner explicitly asks, in this conversation, for a text to be sent. Never invent recipients or bodies, send exactly what the owner asked for, and when re-sending after a delivery complaint, send the SAME intended message again (never your own previous chat reply). After the tool returns, tell the owner the exact body that was sent." +
    OUTBOUND_TIMEZONE_RULE,
  parameters: {
    type: "object",
    properties: {
      toE164: {
        type: "string",
        description: "Recipient phone in E.164, e.g. +15551234567."
      },
      body: {
        type: "string",
        description: "Plain-text message body, at most 1600 characters."
      },
      contactName: CONTACT_NAME_PARAM
    },
    required: ["toE164", "body"]
  }
};

const SEND_WHATSAPP_DECLARATION: GeminiFunctionDeclaration = {
  name: "send_whatsapp",
  description:
    "Send a WhatsApp message from the business's connected WhatsApp number to any phone number. Use ONLY when the owner explicitly asks, in this conversation, for a WHATSAPP message (texting is send_sms). Never invent recipients or bodies. If the recipient hasn't messaged the business on WhatsApp in the last 24 hours, the message is delivered through an approved template; the tool result says which. After the tool returns, tell the owner the exact body that was sent." +
    OUTBOUND_TIMEZONE_RULE,
  parameters: {
    type: "object",
    properties: {
      toE164: {
        type: "string",
        description: "Recipient phone in E.164, e.g. +15551234567."
      },
      body: {
        type: "string",
        description: "Plain-text message body, at most 1600 characters."
      },
      contactName: CONTACT_NAME_PARAM
    },
    required: ["toE164", "body"]
  }
};

const FIND_SLOTS_DECLARATION: GeminiFunctionDeclaration = {
  name: "calendar_find_slots",
  description:
    "Find up to 3 free time ranges on the owner's connected calendar. Use when the owner asks about availability. Times are ISO 8601 with timezone offsets.",
  parameters: {
    type: "object",
    properties: {
      purpose: { type: "string", description: "What the appointment is for (optional)." },
      earliest: { type: "string", description: "Earliest acceptable start, ISO 8601 (optional)." },
      latest: { type: "string", description: "Latest acceptable end, ISO 8601 (optional)." },
      durationMinutes: {
        type: "number",
        description: "Appointment length in minutes (default 30)."
      },
      timezone: { type: "string", description: "IANA timezone for interpreting times (optional)." }
    },
    required: []
  }
};

const BOOK_DECLARATION: GeminiFunctionDeclaration = {
  name: "calendar_book_appointment",
  description:
    "Book an appointment on the owner's connected calendar. Use ONLY when the owner explicitly asks to book, with a confirmed start/end time. Times MUST be ISO 8601 with a timezone offset. Confirm the booked day/time by reading the result's startLocal verbatim. If it fails with attendee_already_booked, the attendee already has an upcoming appointment, follow the result's guidance (keep / reschedule / cancel) and only pass allowAdditional true after the owner explicitly confirms an additional appointment.",
  parameters: {
    type: "object",
    properties: {
      startIso: { type: "string", description: "Start time, ISO 8601 with offset." },
      endIso: { type: "string", description: "End time, ISO 8601 with offset." },
      summary: { type: "string", description: "Short event title." },
      attendeeName: { type: "string", description: "Attendee's name." },
      attendeeEmail: { type: "string", description: "Attendee's email (optional)." },
      attendeePhone: { type: "string", description: "Attendee's phone (optional)." },
      notes: { type: "string", description: "Notes for the event body (optional)." },
      timezone: { type: "string", description: "IANA timezone (optional)." },
      allowAdditional: {
        type: "boolean",
        description:
          "True ONLY after the owner explicitly confirmed an ADDITIONAL appointment on top of the attendee's existing upcoming one."
      }
    },
    required: ["startIso", "endIso", "summary", "attendeeName"]
  }
};

const RESCHEDULE_DECLARATION: GeminiFunctionDeclaration = {
  name: "calendar_reschedule_appointment",
  description:
    "Move an EXISTING appointment to a new time, the invitation is updated in place, never duplicated. Identify the appointment by the attendee's name, phone, or email; pass appointmentStartIso too when the owner names the current time. If several appointments match the name you get multiple_matches with their start times, then ask which one. Times MUST be ISO 8601 with a timezone offset.",
  parameters: {
    type: "object",
    properties: {
      newStartIso: { type: "string", description: "New start time, ISO 8601 with offset." },
      newEndIso: { type: "string", description: "New end time, ISO 8601 with offset." },
      attendeeName: {
        type: "string",
        description: "Attendee's name; enough on its own to find the appointment."
      },
      attendeeEmail: { type: "string", description: "Attendee's email (optional)." },
      attendeePhone: { type: "string", description: "Attendee's phone (optional)." },
      appointmentStartIso: {
        type: "string",
        description:
          "The appointment's CURRENT start, ISO 8601 with offset, whenever the owner names it (for example Tuesday 4pm). Disambiguates same-name appointments."
      },
      timezone: { type: "string", description: "IANA timezone (optional)." }
    },
    required: ["newStartIso", "newEndIso"]
  }
};

const CANCEL_DECLARATION: GeminiFunctionDeclaration = {
  name: "calendar_cancel_appointment",
  description:
    "Cancel an EXISTING appointment, the attendee gets a single cancellation notice. Identify the appointment by the attendee's name, phone, or email; pass appointmentStartIso too when the owner names the current time. If several appointments match the name you get multiple_matches with their start times, then ask which one. Use ONLY when the owner explicitly asks to cancel.",
  parameters: {
    type: "object",
    properties: {
      attendeeName: {
        type: "string",
        description: "Attendee's name; enough on its own to find the appointment."
      },
      attendeeEmail: { type: "string", description: "Attendee's email (optional)." },
      attendeePhone: { type: "string", description: "Attendee's phone (optional)." },
      appointmentStartIso: {
        type: "string",
        description:
          "The appointment's CURRENT start, ISO 8601 with offset, whenever the owner names it (for example Tuesday 4pm). Disambiguates same-name appointments."
      }
    },
    required: []
  }
};

const JOIN_WAITLIST_DECLARATION: GeminiFunctionDeclaration = {
  name: "calendar_join_waitlist",
  description:
    "Put a customer on the cancellation waitlist: when a cancellation frees an appointment slot EARLIER than what they hold (or any slot, if they have no booking), they get ONE text offering it. Use when the owner asks to waitlist someone for an earlier or sooner time. A valid mobile number is required, the offer arrives by text. Never promise that an earlier time WILL open up.",
  parameters: {
    type: "object",
    properties: {
      attendeePhone: {
        type: "string",
        description: "Customer's mobile number (E.164 preferred). Required."
      },
      attendeeName: { type: "string", description: "Customer's name (optional)." },
      attendeeEmail: { type: "string", description: "Customer's email (optional)." },
      durationMinutes: {
        type: "number",
        description: "Appointment length they want in minutes (default 30)."
      },
      latestIso: {
        type: "string",
        description:
          "Latest slot start they would accept, ISO 8601 (optional; defaults to their current booking's start)."
      }
    },
    required: ["attendeePhone"]
  }
};

const LIST_AIFLOWS_DECLARATION: GeminiFunctionDeclaration = {
  name: "list_aiflows",
  description:
    "List this business's AiFlow automations (id, name, enabled, what starts them). Use it to check whether an automation already exists for what the owner is asking, when one matches, OFFER it as an option alongside doing the action directly, and let the owner choose.",
  parameters: { type: "object", properties: {}, required: [] }
};

const RUN_AIFLOW_DECLARATION: GeminiFunctionDeclaration = {
  name: "run_aiflow",
  description:
    "Run one of the business's ENABLED AiFlow automations now (a manual run). Use ONLY after the owner explicitly chooses to run it in this conversation. `flow` is the flow's id or its exact-enough name; `input` is the context text handed to the flow (contact details, notes, whatever the owner supplied). Disabled flows cannot be run, tell the owner to review and enable them at /dashboard/aiflows first.",
  parameters: {
    type: "object",
    properties: {
      flow: { type: "string", description: "Flow id (uuid) or name (case-insensitive match)." },
      input: {
        type: "string",
        description: "Context text passed to the flow as its manual-run input (optional)."
      }
    },
    required: ["flow"]
  }
};

const EDIT_AIFLOW_DECLARATION: GeminiFunctionDeclaration = {
  name: "edit_aiflow",
  description:
    "Edit one of the business's EXISTING AiFlow automations in place, small tweaks (change a message's wording, a wait time, a recipient) or larger restructuring, keeping its id, run history, and enabled state. Use ONLY after the owner explicitly confirmed the exact changes in this conversation: first describe what you will change in plain words and wait for their yes. The change takes effect IMMEDIATELY on the live automation (there is no review step), so never call this speculatively. `flow` is the flow's id or its exact-enough name; `instructions` is the complete, specific change description, including any exact wording the owner gave. The platform validates the edited automation and refuses anything unsafe, when it refuses, the flow is unchanged; relay the reason honestly.",
  parameters: {
    type: "object",
    properties: {
      flow: { type: "string", description: "Flow id (uuid) or name (case-insensitive match)." },
      instructions: {
        type: "string",
        description:
          "The complete requested change, plain English (what to change and the exact new wording/values)."
      },
      newName: {
        type: "string",
        description: "A new name for the automation, ONLY when the owner asked to rename it."
      }
    },
    required: ["flow", "instructions"]
  }
};

const UNDO_AIFLOW_EDIT_DECLARATION: GeminiFunctionDeclaration = {
  name: "undo_aiflow_edit",
  description:
    "Undo the LAST change made to one of the business's existing AiFlow automations, putting the exact previous version back. Use this when the owner says a recent edit was wrong, not what they asked for, or should be reverted (\"put that back\", \"undo what you just changed\", \"that broke it\"). Do NOT try to reverse an edit by calling edit_aiflow with the opposite instruction: that generates a THIRD version rather than restoring the original. Takes effect immediately, and is itself reversible (the undo is recorded too). `flow` is the flow's id or its exact-enough name. Restores the definition and the name; it deliberately does NOT switch the automation on or off.",
  parameters: {
    type: "object",
    properties: {
      flow: { type: "string", description: "Flow id (uuid) or name (case-insensitive match)." }
    },
    required: ["flow"]
  }
};

const GENERATE_IMAGE_DECLARATION: GeminiFunctionDeclaration = {
  name: "generate_image",
  description:
    "Create an AI-generated image for the owner and return a URL plus ready-to-use markdown. Can also EDIT an image: when the owner attached an image to their message (an /api/dashboard/images/... URL) or refers to an image you generated earlier in this conversation, pass that URL as inputImageUrl and describe the change in the prompt. ONLY use this when the owner explicitly asks you to create, generate, edit, or make an image, never call it proactively or as decoration. Embed the returned markdown in your reply so the image renders inline. Expensive: limited per conversation (Standard allows more); when the tool refuses with image_limit_reached, tell the owner plainly.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "A detailed description of the image to generate, or the edit to apply to inputImageUrl, at most 2000 characters."
      },
      aspectRatio: {
        type: "string",
        description: "Optional aspect ratio like 1:1, 3:2, 4:3, 16:9, 9:16. Defaults to 1:1."
      },
      inputImageUrl: {
        type: "string",
        description:
          "Optional source image to edit: an /api/dashboard/images/... URL the owner attached or that you generated earlier in this conversation. Omit to create a new image from scratch."
      }
    },
    required: ["prompt"]
  }
};

// Boolean toggle parameters, one per whitelisted key — self-documenting for
// the model and structurally incapable of carrying recipients (the core
// re-validates regardless).
const NOTIFICATION_TOGGLE_PARAMS = Object.fromEntries(
  NOTIFICATION_TOGGLE_KEYS.map((key) => [
    key,
    { type: "boolean", description: `Set the ${key.replace(/_/g, " ")} toggle.` }
  ])
) as Record<string, { type: string; description: string }>;

const UPDATE_NOTIFICATION_PREFERENCES_DECLARATION: GeminiFunctionDeclaration = {
  name: "update_notification_preferences",
  description:
    "Turn the owner's notification/alert toggles on or off (e.g. customer_reply_alerts to be texted the moment a client texts the business). Use ONLY when the owner explicitly asks, in this conversation, to change how or when they are alerted. Pass only the toggles they asked about. It cannot change the alert phone number or email, that is done from Settings → Notifications. After the tool returns, tell the owner exactly which alerts were changed and their new state.",
  parameters: {
    type: "object",
    properties: NOTIFICATION_TOGGLE_PARAMS,
    required: []
  }
};

const FLAG_CONTACT_SPAM_DECLARATION: GeminiFunctionDeclaration = {
  name: "flag_contact_spam",
  description:
    "PERMANENTLY block a contact as SPAM. Use ONLY when the owner explicitly calls someone spam, junk, fake, a bot, or abusive in this conversation. NEVER use it just because the owner asked to stop texting, stop messaging, or stop following up with someone — that is set_contact_reply_mode, and using this tool instead would irreversibly cut off a real customer. Effects: the number is blocked from ALL outbound texting for this business, every pending automation run for them is canceled, and the contact is tagged spam. The block CANNOT be undone from chat, only the contact texting START lifts it — so when it is not 100% clear the owner means SPAM (not merely quiet), ask them to confirm before calling this. When the owner names a lead without a number, resolve the number from this conversation's context (e.g. the new-lead notification they are replying to). After the tool returns, tell the owner exactly what was done.",
  parameters: {
    type: "object",
    properties: {
      phone: {
        type: "string",
        description: "The number to flag, E.164 preferred, e.g. +15551234567."
      },
      reason: {
        type: "string",
        description: "The owner's stated reason, when they gave one (recorded on the contact)."
      }
    },
    required: ["phone"]
  }
};

const SET_CONTACT_REPLY_MODE_DECLARATION: GeminiFunctionDeclaration = {
  name: "set_contact_reply_mode",
  description:
    'Stop (or resume) the coworker texting one contact. Use mode "suppress" when the owner asks to stop texting, stop messaging, leave alone, or stop following up with someone — the coworker stops auto-replying to that contact and their pending automation runs are stopped, while the contact can still text in, the owner can still text them manually, and calls are unaffected. Use mode "auto" when the owner asks to resume normal replies to them. Fully reversible; this is thread management, NOT a spam block (a contact the owner explicitly calls spam/junk/abusive is flag_contact_spam instead). After the tool returns, tell the owner exactly what changed.',
  parameters: {
    type: "object",
    properties: {
      phone: {
        type: "string",
        description: "The contact's number, E.164 preferred, e.g. +15551234567."
      },
      mode: {
        type: "string",
        description:
          '"suppress" to stop the coworker texting them, "auto" to resume normal replies.'
      }
    },
    required: ["phone", "mode"]
  }
};

const MANAGE_EMPLOYEE_DECLARATION: GeminiFunctionDeclaration = {
  name: "manage_employee",
  description:
    'Add, edit, deactivate, or reactivate someone on the business\'s employee roster, and control how they receive leads. Use ONLY when the owner asks for a roster change in this conversation ("add Sandy, her cell is 602 555 0134", "Gabby\'s number changed", "take Dave off lead rotation", "Jason is back from leave"). The roster decides who gets lead offers, so: read a NEW teammate\'s number back digit by digit after adding them, and CONFIRM with the owner before deactivating anyone or turning lead rotation off, because both immediately redirect live leads to other people. Never invent a number or a name. To change someone, identify them in "employee" by their roster name or their phone number. Turning a lead-availability switch off never affects the owner\'s own alerts. After the tool returns, tell the owner exactly what changed.',
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description:
          '"add" a new teammate, "update" an existing one, "deactivate" (they stop receiving everything, history kept), or "reactivate".'
      },
      employee: {
        type: "string",
        description:
          'Who to change for update/deactivate/reactivate: their roster name or phone number. Omit for "add".'
      },
      name: {
        type: "string",
        description: 'The new teammate\'s name for "add", or the corrected name for "update".'
      },
      phone: {
        type: "string",
        description:
          'The new teammate\'s mobile number for "add", or the corrected number for "update". E.164 preferred, e.g. +16025551234.'
      },
      email: {
        type: "string",
        description: "Their email, when the owner gives one. Send an empty string to clear it."
      },
      scheduleText: {
        type: "string",
        description:
          'Working hours in the compact form "mon-fri 09:00-17:00; sat 10:00-14:00". Outside these hours they are not offered leads. Empty string clears the schedule (always available).'
      },
      preferredText: {
        type: "string",
        description:
          "Preferred lead hours, same format. Soft priority only: it moves them to the front of the rotation during those hours, never excludes them."
      },
      leadRotation: {
        type: "boolean",
        description:
          "Whether they receive leads in the round robin, including automatic assignment. False stops those; it does NOT stop an automation that asks for them by name (that is namedLeads)."
      },
      namedLeads: {
        type: "boolean",
        description:
          'Whether an automation can send them one lead by asking for them specifically ("I want Amy on this one"). Independent of leadRotation, so someone can be out of the round robin and still reachable by name.'
      },
      namedGroupOffers: {
        type: "boolean",
        description:
          'Whether they are included when an automation texts one lead to several named people at once and the first to reply "1" takes it.'
      },
      wholeTeamOffers: {
        type: "boolean",
        description:
          "Whether they are included when something is offered to the entire team at once, such as the team-first human handoff."
      }
    },
    required: ["action"]
  }
};

const DECLARATIONS: Record<ActionToolName, GeminiFunctionDeclaration> = {
  send_sms: SEND_SMS_DECLARATION,
  send_whatsapp: SEND_WHATSAPP_DECLARATION,
  calendar_find_slots: FIND_SLOTS_DECLARATION,
  calendar_book_appointment: BOOK_DECLARATION,
  calendar_reschedule_appointment: RESCHEDULE_DECLARATION,
  calendar_cancel_appointment: CANCEL_DECLARATION,
  calendar_join_waitlist: JOIN_WAITLIST_DECLARATION,
  list_aiflows: LIST_AIFLOWS_DECLARATION,
  run_aiflow: RUN_AIFLOW_DECLARATION,
  edit_aiflow: EDIT_AIFLOW_DECLARATION,
  undo_aiflow_edit: UNDO_AIFLOW_EDIT_DECLARATION,
  generate_image: GENERATE_IMAGE_DECLARATION,
  update_notification_preferences: UPDATE_NOTIFICATION_PREFERENCES_DECLARATION,
  flag_contact_spam: FLAG_CONTACT_SPAM_DECLARATION,
  set_contact_reply_mode: SET_CONTACT_REPLY_MODE_DECLARATION,
  manage_employee: MANAGE_EMPLOYEE_DECLARATION
};

/** The declarations for every gate that is ON, in stable order. */
export function actionToolDeclarations(gates: ActionToolGates): GeminiFunctionDeclaration[] {
  return ACTION_TOOL_NAMES.filter((name) => gates[name]).map((name) => DECLARATIONS[name]);
}

// ---------------------------------------------------------------------
// Arg schemas — kept in lockstep with /api/rowboat/tool-call so both turn
// paths accept the same shapes.
// ---------------------------------------------------------------------

const sendSmsArgsSchema = z.object({
  toE164: z.string().min(5).max(32),
  body: z.string().min(1).max(1600),
  contactName: z.string().max(120).optional()
});

const sendWhatsAppArgsSchema = z.object({
  toE164: z.string().min(5).max(32),
  body: z.string().min(1).max(1600),
  contactName: z.string().max(120).optional()
});

// Booleans per whitelisted toggle. PASSTHROUGH (not strict/strip): unknown
// keys must reach the core, whose refusal names the real toggle list —
// stripping them would misreport "no_toggles", and a schema error is less
// actionable for the model. The core owns unknown-key + enable-only
// refusals for every surface (shared with /api/rowboat/tool-call).
export const updateNotificationPreferencesArgsSchema = z
  .object(
    Object.fromEntries(
      NOTIFICATION_TOGGLE_KEYS.map((key) => [key, z.boolean().optional()])
    ) as Record<string, z.ZodOptional<z.ZodBoolean>>
  )
  .passthrough();

const findSlotsArgsSchema = z.object({
  purpose: z.string().max(200).optional(),
  earliest: z.string().optional(),
  latest: z.string().optional(),
  durationMinutes: z.number().int().min(5).max(480).default(30),
  timezone: z.string().optional(),
  serviceId: z.string().max(120).optional()
});

const bookAppointmentArgsSchema = z.object({
  startIso: z.string().datetime({ offset: true }),
  endIso: z.string().datetime({ offset: true }),
  summary: z.string().min(1).max(200),
  attendeeName: z.string().min(1).max(200),
  attendeeEmail: z.string().email().optional(),
  attendeePhone: z.string().max(32).optional(),
  notes: z.string().max(2000).optional(),
  timezone: z.string().optional(),
  serviceId: z.string().max(120).optional(),
  // Explicit escape hatch for the attendee duplicate guard.
  allowAdditional: z.boolean().optional()
});

const rescheduleAppointmentArgsSchema = z.object({
  newStartIso: z.string().datetime({ offset: true }),
  newEndIso: z.string().datetime({ offset: true }),
  attendeeName: z.string().max(200).optional(),
  attendeeEmail: z.string().email().optional(),
  attendeePhone: z.string().max(32).optional(),
  appointmentStartIso: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().optional()
});

const cancelAppointmentArgsSchema = z.object({
  attendeeName: z.string().max(200).optional(),
  attendeeEmail: z.string().email().optional(),
  attendeePhone: z.string().max(32).optional(),
  appointmentStartIso: z.string().datetime({ offset: true }).optional()
});

const joinWaitlistArgsSchema = z.object({
  attendeePhone: z.string().min(5).max(32),
  attendeeName: z.string().max(200).optional(),
  attendeeEmail: z.string().email().optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  latestIso: z.string().optional(),
  timezone: z.string().optional()
});

// Flow-run/edit arg schemas live with the shared cores (manual-run-tool.ts /
// edit-flow-tool.ts) so every caller accepts identical shapes.
const runAiflowArgsSchema = runAiflowToolArgsSchema;
const editAiflowArgsSchema = editAiflowToolArgsSchema;

const undoAiflowArgsSchema = undoAiflowToolArgsSchema;

const flagContactSpamArgsSchema = z.object({
  phone: z.string().min(5).max(32),
  reason: z.string().max(500).optional()
});

const setContactReplyModeArgsSchema = z.object({
  phone: z.string().min(5).max(32),
  mode: z.enum(["suppress", "auto"])
});

const manageEmployeeArgsSchema = z.object({
  action: z.enum(["add", "update", "deactivate", "reactivate"]),
  employee: z.string().max(160).optional(),
  name: z.string().max(120).optional(),
  phone: z.string().max(32).optional(),
  email: z.string().max(254).optional(),
  scheduleText: z.string().max(500).optional(),
  preferredText: z.string().max(500).optional(),
  leadRotation: z.boolean().optional(),
  namedLeads: z.boolean().optional(),
  namedGroupOffers: z.boolean().optional(),
  wholeTeamOffers: z.boolean().optional()
});

// Same caps as the Rowboat dispatch's dashboardGenerateImageArgsSchema.
const generateImageArgsSchema = z.object({
  prompt: z.string().min(1).max(2000),
  aspectRatio: z.string().max(10).optional(),
  inputImageUrl: z.string().max(300).optional()
});

// ---------------------------------------------------------------------
// Owner-surface guidance (dashboard chat talks TO the owner, so the
// escalation arm of the Rowboat guidance — notify_team / capture_lead —
// doesn't apply; the honest move here is telling the owner directly).
// ---------------------------------------------------------------------

function bookFailureGuidance(detail: string): string {
  if (detail === "calendar_not_connected") {
    return (
      "No calendar is connected, so you cannot book anything. Tell the owner plainly and " +
      "point them to /dashboard/integrations to connect a calendar."
    );
  }
  return (
    "The booking did not go through, treat that time as no longer available and never " +
    "blame a technical error. Re-check availability with calendar_find_slots and offer a " +
    "fresh option, or tell the owner the booking could not be completed."
  );
}

function lifecycleFailureGuidance(detail: string, verb: "reschedule" | "cancel"): string | null {
  if (detail === "booking_not_found") {
    return (
      "No upcoming appointment was found for that person. Ask the owner for the " +
      "appointment's current time (pass it as appointmentStartIso), or the phone number or " +
      `email it was booked under. Never book a new appointment to fake a ${verb}.`
    );
  }
  if (detail === "calendar_not_connected") {
    return (
      "No calendar is connected, so you cannot change or cancel any appointment. Tell the " +
      "owner plainly and point them to /dashboard/integrations."
    );
  }
  if (detail === "calendar_reschedule_failed" || detail === "calendar_cancel_failed") {
    return (
      `The ${verb} did not go through, never blame a technical error and never book a ` +
      "second appointment as a workaround. Tell the owner it could not be completed."
    );
  }
  return null;
}

const RESCHEDULE_LINK_STEERING =
  "The appointment has NOT been moved yet. Give the owner the rescheduleLink so the " +
  "attendee picks the new time themselves, the SAME appointment gets updated when they " +
  "finish. Never state the reschedule is done or confirm a new time.";

// ---------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------

export type ActionToolDeps = {
  /** Injectable cores (tests). */
  getMessagingConfig?: typeof getTelnyxMessagingForBusiness;
  sendSms?: typeof sendTelnyxSms;
  sendWhatsApp?: typeof deliverWhatsApp;
  checkOptOut?: typeof checkSmsOptOut;
  findSlots?: typeof findCalendarSlots;
  book?: typeof bookCalendarAppointment;
  reschedule?: typeof rescheduleCalendarAppointment;
  cancel?: typeof cancelCalendarAppointment;
  joinWaitlist?: typeof joinCalendarWaitlist;
  createDb?: typeof createSupabaseServiceClient;
  listFlows?: typeof listAiFlows;
  enqueueFlowRun?: typeof enqueueAiFlowRun;
  compileFlowEdit?: typeof editAiFlowDefinition;
  persistFlowUpdate?: typeof updateAiFlow;
  generateImage?: typeof generateImageForDashboard;
  recordContactInteraction?: typeof recordInteractionAndIncrement;
  applyNotificationToggles?: typeof applyNotificationPreferenceToggles;
  flagSpam?: typeof flagContactSpam;
  setReplyMode?: typeof setContactTextingMode;
  manageRoster?: typeof manageEmployee;
  undoFlowEdit?: typeof undoAiFlowEditTool;
  /** Flow-edit provenance for the snapshot trigger; see edit-flow-tool.ts. */
  flowEditSource?: string;
  flowEditActor?: string | null;
};

/**
 * Execute one inline action tool call; the returned payload becomes the
 * Gemini functionResponse. Never throws.
 */
export async function executeActionTool(
  businessId: string,
  call: { name: ActionToolName; args: Record<string, unknown> },
  deps: ActionToolDeps = {}
): Promise<unknown> {
  /* c8 ignore start -- production defaults; tests inject */
  const getMessagingConfig = deps.getMessagingConfig ?? getTelnyxMessagingForBusiness;
  const sendSms = deps.sendSms ?? sendTelnyxSms;
  const sendWhatsApp = deps.sendWhatsApp ?? deliverWhatsApp;
  const checkOptOut = deps.checkOptOut ?? checkSmsOptOut;
  const findSlots = deps.findSlots ?? findCalendarSlots;
  const book = deps.book ?? bookCalendarAppointment;
  const reschedule = deps.reschedule ?? rescheduleCalendarAppointment;
  const cancel = deps.cancel ?? cancelCalendarAppointment;
  const joinWaitlist = deps.joinWaitlist ?? joinCalendarWaitlist;
  const createDb = deps.createDb ?? createSupabaseServiceClient;
  const listFlows = deps.listFlows ?? listAiFlows;
  const enqueueFlowRun = deps.enqueueFlowRun ?? enqueueAiFlowRun;
  const compileFlowEdit = deps.compileFlowEdit ?? editAiFlowDefinition;
  const persistFlowUpdate = deps.persistFlowUpdate ?? updateAiFlow;
  const generateImage = deps.generateImage ?? generateImageForDashboard;
  const recordContactInteraction = deps.recordContactInteraction ?? recordInteractionAndIncrement;
  const applyNotificationToggles =
    deps.applyNotificationToggles ?? applyNotificationPreferenceToggles;
  const flagSpam = deps.flagSpam ?? flagContactSpam;
  const setReplyMode = deps.setReplyMode ?? setContactTextingMode;
  const manageRoster = deps.manageRoster ?? manageEmployee;
  const undoAiFlowEdit = deps.undoFlowEdit ?? undoAiFlowEditTool;
  /* c8 ignore stop */

  // Outbound-first recipients must exist as contacts (KYP/Ayanna, Jul 20
  // 2026: a number the owner texted twice had NO contact row, so the
  // assistant told James "I don't have any record of Ayanna" hours after
  // texting her for him). Rollup only — deliberately NOT ensureCapturedContact,
  // so an owner-initiated outbound never fires contact_created lead-follow-up
  // automations. Best-effort: a failed upsert never fails a sent message.
  const upsertRecipientContact = async (
    toPhone: string,
    channel: "sms" | "whatsapp",
    contactName: string | undefined
  ): Promise<void> => {
    try {
      const db = await createDb();
      await recordContactInteraction(
        businessId,
        toPhone,
        channel,
        { displayName: contactName?.trim() || null },
        db as never
      );
    } catch (err) {
      logger.warn(`dashboard-chat ${channel === "sms" ? "send_sms" : "send_whatsapp"}: contact upsert failed`, {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  };

  try {
    switch (call.name) {
      case "send_sms": {
        const parsed = sendSmsArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        // Canonicalize BEFORE the opt-out check and the send — STOP rows are
        // stored canonical, so a differently-formatted destination must not
        // slip past the exact-match check.
        const normalized = normalizeContactNumber(parsed.data.toE164);
        if (!normalized.ok) {
          return { ok: false, message: "invalid_destination" };
        }
        const toPhone = normalized.value;
        const optOut = await checkOptOut(businessId, toPhone);
        if (!optOut.ok) {
          logger.error("dashboard-chat send_sms: opt-out check failed; refusing (fail closed)", {
            businessId,
            error: optOut.error
          });
          return { ok: false, message: "opt_out_check_failed" };
        }
        if (optOut.optedOut) {
          return {
            ok: false,
            message:
              "recipient_opted_out, this number texted STOP and cannot be messaged. Tell the owner."
          };
        }
        const config = await getMessagingConfig(businessId, undefined, { resolveRcs: true });
        let messageId: string;
        let channel: string | undefined;
        try {
          const sent = await sendSms(config, toPhone, parsed.data.body, {
            meterBusinessId: businessId
          });
          messageId = sent.id;
          channel = sent.channel;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const isQuota = /Monthly SMS limit|SMS quota blocked|throttled/i.test(message);
          logger.warn("dashboard-chat send_sms: send failed", { businessId, error: message });
          return {
            ok: false,
            message: isQuota
              ? "sms_quota_blocked, the monthly SMS limit is used up. Tell the owner; do not retry."
              : "sms_send_failed, the text did NOT go out. Tell the owner honestly."
          };
        }
        // Best-effort durable log so the text renders in the dashboard Text
        // history (source dashboard_chat). A failed insert must not fail the
        // tool call — the SMS already went out.
        try {
          const db = await createDb();
          const { error: logErr } = await db.from("sms_outbound_log").insert({
            business_id: businessId,
            to_e164: toPhone,
            from_e164: config.fromE164 ?? null,
            body: parsed.data.body,
            source: "dashboard_chat",
            run_id: null,
            flow_id: null,
            telnyx_message_id: messageId,
            channel
          });
          if (logErr) throw new Error(logErr.message);
        } catch (logErr) {
          logger.error("dashboard-chat send_sms: outbound log insert failed", {
            businessId,
            error: logErr instanceof Error ? logErr.message : String(logErr)
          });
        }
        await upsertRecipientContact(toPhone, "sms", parsed.data.contactName);
        return {
          ok: true,
          messageId,
          toE164: toPhone,
          sentBody: parsed.data.body,
          note: "Tell the owner the exact message body that was texted."
        };
      }
      case "send_whatsapp": {
        const parsed = sendWhatsAppArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        const normalized = normalizeContactNumber(parsed.data.toE164);
        if (!normalized.ok) {
          return { ok: false, message: "invalid_destination" };
        }
        const delivered = await sendWhatsApp({
          businessId,
          to: normalized.value,
          text: parsed.data.body,
          audience: "contact"
        });
        if (!delivered.ok) {
          if (delivered.reason === "not_connected") {
            return {
              ok: false,
              message:
                "whatsapp_not_connected, WhatsApp isn't connected. Point the owner to /dashboard/integrations/whatsapp."
            };
          }
          if (delivered.reason === "connection_inactive") {
            return {
              ok: false,
              message:
                "whatsapp_connection_inactive, the WhatsApp connection is inactive or expired. Point the owner to /dashboard/integrations/whatsapp to reconnect."
            };
          }
          if (delivered.reason === "template_not_approved") {
            return {
              ok: false,
              message:
                "whatsapp_window_closed, the recipient hasn't messaged on WhatsApp in 24 hours and the message template is still in Meta review. Suggest texting them with send_sms instead."
            };
          }
          return {
            ok: false,
            message: "whatsapp_send_failed, the message did NOT go out. Tell the owner honestly."
          };
        }
        await upsertRecipientContact(normalized.value, "whatsapp", parsed.data.contactName);
        return {
          ok: true,
          messageId: delivered.messageId,
          toE164: normalized.value,
          sentBody: parsed.data.body,
          via: delivered.via,
          note:
            delivered.via === "template"
              ? "Delivered through the approved template (the recipient was outside the 24-hour window). Tell the owner the exact message body that was sent."
              : "Tell the owner the exact message body that was sent."
        };
      }
      case "calendar_find_slots": {
        const parsed = findSlotsArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        return await findSlots(businessId, parsed.data);
      }
      case "calendar_book_appointment": {
        const parsed = bookAppointmentArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        const booked = await book(businessId, parsed.data, null);
        if (
          !booked.ok &&
          (booked.detail === "calendar_book_failed" || booked.detail === "calendar_not_connected")
        ) {
          return { ...booked, message: bookFailureGuidance(booked.detail) };
        }
        return booked;
      }
      case "calendar_reschedule_appointment": {
        const parsed = rescheduleAppointmentArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        const rescheduled = await reschedule(businessId, parsed.data, null);
        if (!rescheduled.ok && rescheduled.detail) {
          const message = lifecycleFailureGuidance(rescheduled.detail, "reschedule");
          if (message) return { ...rescheduled, message };
        }
        // Calendly cannot move an event on the invitee's behalf: the tool
        // returns the invitee's own reschedule link. Without this steering
        // the model would confirm a new time that does not exist yet.
        if (rescheduled.ok && rescheduled.detail === "reschedule_link_created") {
          return { ...rescheduled, message: RESCHEDULE_LINK_STEERING };
        }
        return rescheduled;
      }
      case "calendar_cancel_appointment": {
        const parsed = cancelAppointmentArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        const canceled = await cancel(businessId, parsed.data, null);
        if (!canceled.ok && canceled.detail) {
          const message = lifecycleFailureGuidance(canceled.detail, "cancel");
          if (message) return { ...canceled, message };
        }
        return canceled;
      }
      case "calendar_join_waitlist": {
        const parsed = joinWaitlistArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        // The core carries its own model-facing guidance on failures.
        return await joinWaitlist(businessId, parsed.data, null);
      }
      case "list_aiflows": {
        // Shared core with the Rowboat dispatcher's dashboard_list_aiflows.
        return await listAiFlowsTool(businessId, { listFlows });
      }
      case "run_aiflow": {
        const parsed = runAiflowArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        // Shared core with the Rowboat dispatcher's dashboard_run_aiflow.
        return await runAiFlowTool(businessId, parsed.data, { listFlows, enqueueFlowRun });
      }
      case "edit_aiflow": {
        const parsed = editAiflowArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        // Shared core (edit-flow-tool.ts): validated in-place edit — the
        // compile pipeline refuses anything short of a clean definition, so
        // a live flow is never left half-edited.
        return await editAiFlowTool(businessId, parsed.data, {
          listFlows,
          compileEdit: compileFlowEdit,
          persistUpdate: persistFlowUpdate,
          ...(deps.flowEditSource !== undefined ? { editSource: deps.flowEditSource } : {}),
          ...(deps.flowEditActor !== undefined ? { editActor: deps.flowEditActor } : {})
        });
      }
      case "undo_aiflow_edit": {
        const parsed = undoAiflowArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        // Shared core (undo-flow-tool.ts): restore the previous definition
        // through updateAiFlow, so the restore validates and is snapshotted
        // like any other edit.
        return await undoAiFlowEdit(businessId, parsed.data, {
          listFlows,
          ...(deps.flowEditSource !== undefined ? { editSource: deps.flowEditSource } : {}),
          ...(deps.flowEditActor !== undefined ? { editActor: deps.flowEditActor } : {})
        });
      }
      case "generate_image": {
        const parsed = generateImageArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        // Same core the Rowboat dashboard_generate_image dispatch calls:
        // budget gate → 3-per-thread limit → generate → store → meter. The
        // result's markdown is what the model must embed so the chat UI
        // renders the image inline.
        return await generateImage(businessId, parsed.data.prompt, {
          aspectRatio: normalizeAspectRatio(parsed.data.aspectRatio),
          ...(parsed.data.inputImageUrl ? { inputImageRef: parsed.data.inputImageUrl } : {})
        });
      }
      case "update_notification_preferences": {
        const parsed = updateNotificationPreferencesArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        // FULL boolean control on this surface: the chat route only declares
        // the tool when the authed caller passed manage_settings this turn
        // (see ActionToolGates.update_notification_preferences).
        const result = await applyNotificationToggles(businessId, parsed.data);
        if (!result.ok) return result;
        return {
          ok: true,
          ...result.data,
          note: "Tell the owner exactly which alerts were changed and their new state."
        };
      }
      case "flag_contact_spam": {
        const parsed = flagContactSpamArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        // Shared core: opt-out suppression (load-bearing, fails honestly) →
        // pending-run cancels → contact tag. Never throws.
        return await flagSpam(businessId, parsed.data);
      }
      case "set_contact_reply_mode": {
        const parsed = setContactReplyModeArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        // Shared core: reply-mode write (load-bearing, fails honestly) →
        // pending-run cancels on suppress. Never throws.
        return await setReplyMode(businessId, parsed.data);
      }
      case "manage_employee": {
        const parsed = manageEmployeeArgsSchema.safeParse(call.args);
        if (!parsed.success) {
          return { ok: false, message: `invalid_args:${parsed.error.issues[0]?.message}` };
        }
        // Shared core: the same db helpers the Employees page writes through,
        // so the AI path and the page cannot drift. Never throws.
        return await manageRoster(businessId, parsed.data);
      }
    }
  } catch (err) {
    // A tool blow-up must never kill the chat turn — degrade to an honest
    // failure the model can relay to the owner.
    logger.warn("dashboard-chat action tool failed", {
      businessId,
      tool: call.name,
      error: err instanceof Error ? err.message : String(err)
    });
    return {
      ok: false,
      message: "The tool failed unexpectedly. Tell the owner it did not complete, never pretend it did."
    };
  }
}
