/**
 * The voice bridge's Gemini Live tool declarations for the customer/staff
 * receptionist persona — extracted from gemini-telnyx-bridge.ts so
 * repo-root tests (tests/e2e/voice-tools.e2e.test.ts) and typecheck can
 * import the REAL declarations WITHOUT pulling the bridge's runtime deps
 * (`@google/genai`, `ws`) that are only installed on the VPS. Same
 * rationale and rules as system-instruction.ts: only dependency-free
 * siblings may be imported here.
 *
 * `Type` mirrors @google/genai's string enum values exactly (Type.OBJECT
 * === "OBJECT" etc.), so the declarations the bridge sends to Gemini Live
 * are byte-identical to before the extraction.
 */

const Type = {
  OBJECT: "OBJECT",
  STRING: "STRING",
  NUMBER: "NUMBER",
  BOOLEAN: "BOOLEAN",
  ARRAY: "ARRAY"
} as const;

export type VoiceToolDeclaration = {
  name: string;
  description: string;
  parameters: unknown;
};

export function buildVoiceToolDeclarations(): VoiceToolDeclaration[] {
  return [
    {
      name: "business_knowledge_lookup",
      description:
        "Look up a specific fact about this business (hours, services, pricing, policies, location) when your static briefing doesn't answer the caller's question. Returns a short factual summary.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          question: {
            type: Type.STRING,
            description: "A short, concrete question to answer from the business's knowledge base."
          }
        },
        required: ["question"]
      }
    },
    {
      name: "calendar_find_slots",
      description:
        "Find open appointment slots on the business calendar for a given window. Use when the caller wants to schedule something. Returns up to ~6 candidate slots in ISO-8601.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          purpose: {
            type: Type.STRING,
            description: "Short reason for the appointment (e.g. 'property viewing', 'consultation')."
          },
          earliest: {
            type: Type.STRING,
            description: "Earliest acceptable start time, ISO-8601. Defaults to 'as soon as possible'."
          },
          latest: {
            type: Type.STRING,
            description: "Latest acceptable end time, ISO-8601. Defaults to one week out."
          },
          durationMinutes: {
            type: Type.NUMBER,
            description: "Requested slot length in minutes. Defaults to 30."
          }
        },
        required: ["purpose"]
      }
    },
    {
      name: "calendar_book_appointment",
      description:
        "Book an appointment on the business calendar. Only call AFTER `calendar_find_slots` confirmed a slot AND the caller has said yes to that ONE specific time out loud — never book while they are still choosing between options, and never book more than one slot per caller. On success, confirm the day and time by reading the result's `startLocal` back to the caller — never work out the day yourself. Mention a calendar invite ONLY if the result's `inviteEmail` is set; when it is null the caller gets NO invite — do not promise one (offer a text confirmation via `send_follow_up_sms` instead). If the result has detail `attendee_already_booked`, this caller ALREADY has an upcoming appointment — tell them its `existingStartLocal` time and follow the result's message (keep it, move it with `calendar_reschedule_appointment`, or cancel it); only retry with `allowAdditional` true after they explicitly confirm they want a separate additional appointment. If the result has detail `booking_link_created` with a `bookingLink` (Calendly accounts), the appointment is NOT booked yet — text the link to the caller with `send_follow_up_sms` and tell them to complete the booking there; never describe it as confirmed.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          startIso: { type: Type.STRING, description: "Slot start in ISO-8601 with timezone." },
          endIso: { type: Type.STRING, description: "Slot end in ISO-8601 with timezone." },
          attendeeName: { type: Type.STRING, description: "Caller's name." },
          attendeeEmail: { type: Type.STRING, description: "Caller's email if known." },
          attendeePhone: { type: Type.STRING, description: "Caller's phone if known." },
          summary: {
            type: Type.STRING,
            description: "One-sentence subject/summary of the appointment."
          },
          notes: {
            type: Type.STRING,
            description: "Any extra context the owner should know before the meeting."
          },
          allowAdditional: {
            type: Type.BOOLEAN,
            description:
              "True ONLY after the caller explicitly confirmed they want an ADDITIONAL appointment on top of their existing upcoming one."
          }
        },
        required: ["startIso", "endIso", "attendeeName", "summary"]
      }
    },
    {
      name: "send_follow_up_sms",
      description:
        "Send the caller a short follow-up SMS (links, addresses, summaries). Keep to <= 300 chars. The body must only contain facts the caller stated or a tool returned — no invented details, and no appointment described as scheduled unless it was actually booked. To text the CALLER, OMIT toE164 entirely — it defaults to the number they are calling from, which you cannot see; NEVER fill it with a guessed or placeholder number.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          toE164: {
            type: Type.STRING,
            description:
              "Destination phone in E.164 — ONLY when the caller explicitly dictated a different number to you. Omit to text the caller on the line they are calling from."
          },
          body: { type: Type.STRING, description: "Message body. Plain text." }
        },
        required: ["body"]
      }
    },
    {
      name: "send_follow_up_email",
      description:
        "Email the caller a follow-up. Requires an active workspace connection (Gmail or Outlook). If none is connected the tool returns `email_not_connected`; fall back to SMS or a spoken promise.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          toEmail: { type: Type.STRING, description: "Recipient email address." },
          subject: { type: Type.STRING, description: "Short subject line." },
          bodyText: { type: Type.STRING, description: "Plain-text email body." },
          cc: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Optional cc email addresses, at most 10. Only use addresses the caller gave you."
          },
          bcc: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Optional bcc email addresses, at most 10. Only use addresses the caller gave you."
          }
        },
        required: ["toEmail", "subject", "bodyText"]
      }
    },
    {
      name: "notify_team",
      description:
        "Relay a caller request to the business owner/team (dashboard alert plus email/SMS per the owner's settings). Call this BEFORE telling the caller you'll check with the team, pass a message along, or have someone get back to them — it is your ONLY channel to the team. Include what the team must do and any deadline the caller mentioned.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          message: {
            type: Type.STRING,
            description:
              "What the team needs to do, in one or two sentences (e.g. 'Confirm whether the Maple Street property can be shown tomorrow at 2pm and text the caller back')."
          },
          callerName: { type: Type.STRING, description: "Caller's name if known." },
          callerPhone: {
            type: Type.STRING,
            description: "Callback number in E.164 if different from the caller's ANI."
          }
        },
        required: ["message"]
      }
    },
    {
      name: "document_share",
      description:
        "Text the caller an expiring link to one of the business's documents (price sheet, policy, contract, brochure) when they ask for a copy. Refer to the document by its title from your documents.md briefing. Internal/staff documents and expired documents are refused server-side — if the tool fails, tell the caller the team will follow up with a copy.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          document: {
            type: Type.STRING,
            description: "The document's title (or part of it) as listed in your briefing."
          },
          phone: {
            type: Type.STRING,
            description: "Destination phone in E.164. Defaults to the caller's ANI if omitted."
          },
          message: {
            type: Type.STRING,
            description: "Optional short intro sentence to send with the link."
          }
        },
        required: ["document"]
      }
    },
    {
      name: "capture_caller_details",
      description:
        "Log caller-provided details (name, phone, email, reason, preferences) so the owner can follow up. Call as soon as the caller gives you any of these details.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          phone: { type: Type.STRING, description: "Phone, E.164 if known." },
          email: { type: Type.STRING },
          reason: {
            type: Type.STRING,
            description: "One-sentence reason for the call."
          },
          notes: {
            type: Type.STRING,
            description: "Any other useful context — preferences, urgency, constraints."
          },
          urgency: {
            type: Type.STRING,
            description: "'low', 'normal', or 'high' — high escalates to the owner."
          }
        },
        required: []
      }
    },
    {
      name: "customer_lookup_by_phone",
      description:
        "Look up the cross-channel customer profile (display name, rolling summary, last channel/date, total interaction count) for a caller's phone. Defaults to the current caller's phone when called without args. Use to recognize repeat callers and continue prior conversations naturally — but never read the summary verbatim, treat it as your own working notes.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          phone: {
            type: Type.STRING,
            description:
              "E.164 phone to look up. Omit to use the current caller's phone."
          }
        },
        required: []
      }
    },
    {
      name: "customer_set_display_name",
      description:
        "Persist the caller's name on their customer profile so future calls/SMS recognize them. Call this when the caller gives their name on the call. Won't overwrite a name the owner already set from the dashboard.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          displayName: {
            type: Type.STRING,
            description:
              "The caller's name as you heard it. Will be normalized server-side."
          },
          phone: {
            type: Type.STRING,
            description:
              "E.164 phone to attribute the name to. Omit for the current caller."
          }
        },
        required: ["displayName"]
      }
    },
    {
      name: "customer_append_pinned_note",
      description:
        "Append a permanent fact to this customer's pinned notes (e.g. 'wife is allergic to nuts', 'closes at 4 every other Friday'). The note survives every future summary and is visible to the owner on the dashboard. Use sparingly — only for facts that should reach the next conversation verbatim.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          note: {
            type: Type.STRING,
            description: "The fact to pin, in the caller's words. Keep concise."
          },
          phone: {
            type: Type.STRING,
            description:
              "E.164 phone to attribute the note to. Omit for the current caller."
          }
        },
        required: ["note"]
      }
    }
  ];
}
