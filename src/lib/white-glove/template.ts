/**
 * White-glove build questionnaire + document generator.
 *
 * Distilled from PRDs/Lead Management.pdf into a short, plain-English,
 * industry-agnostic intake: the PROSPECT answers ~20 mostly-multiple-choice
 * questions on the public /intake/<token> page, and `renderWhiteGloveDoc`
 * merges those answers into the finished "White-Glove Build & Installation"
 * document the operator works from (and the customer signs off on).
 *
 * Everything here is pure: the questionnaire definition drives the public
 * form UI, `intakeAnswersSchema` validates the submission server-side, and
 * the renderer produces the same document as markdown (download) or as
 * structured sections (the print-ready admin view).
 */
import { z } from "zod";

export type IntakeChoiceOption = { value: string; label: string };

export type IntakeQuestion = {
  id: keyof IntakeAnswers;
  section: string;
  label: string;
  /** Short helper line shown under the label. */
  help?: string;
  type: "choice" | "multi" | "text" | "textarea";
  options?: IntakeChoiceOption[];
  placeholder?: string;
  required: boolean;
  /**
   * Input cap for text/textarea questions — MUST match the field's
   * intakeAnswersSchema max so the form can never accept input the submit
   * route then rejects (enforced by unit test).
   */
  maxLength?: number;
};

// ── Choice catalogs ─────────────────────────────────────────────────────────

export const INDUSTRY_OPTIONS: IntakeChoiceOption[] = [
  { value: "real_estate", label: "Real estate" },
  { value: "insurance", label: "Insurance" },
  { value: "home_services", label: "Home services (HVAC, plumbing, roofing…)" },
  { value: "legal", label: "Legal" },
  { value: "health_wellness", label: "Health & wellness" },
  { value: "other", label: "Other" }
];

const LEAD_SOURCE_OPTIONS: IntakeChoiceOption[] = [
  { value: "facebook_instagram", label: "Facebook / Instagram ads" },
  { value: "website_form", label: "Website form" },
  { value: "google", label: "Google ads / search" },
  { value: "phone_calls", label: "Phone calls" },
  { value: "referrals", label: "Referrals" },
  { value: "other", label: "Other" }
];

const TONE_OPTIONS: IntakeChoiceOption[] = [
  { value: "friendly", label: "Friendly and warm" },
  { value: "professional", label: "Professional and polished" },
  { value: "casual", label: "Casual and relaxed" }
];

const APPOINTMENT_LENGTH_OPTIONS: IntakeChoiceOption[] = [
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "45", label: "45 minutes" },
  { value: "60", label: "1 hour" }
];

const APPOINTMENT_BUFFER_OPTIONS: IntakeChoiceOption[] = [
  { value: "none", label: "No buffer needed" },
  { value: "15", label: "15 minutes between appointments" },
  { value: "30", label: "30 minutes between appointments" }
];

const BOOKING_NOTICE_OPTIONS: IntakeChoiceOption[] = [
  { value: "asap", label: "Same day is fine, even short notice" },
  { value: "2h", label: "At least 2 hours ahead" },
  { value: "next_day", label: "Next business day at the earliest" }
];

const BOOKING_WINDOW_OPTIONS: IntakeChoiceOption[] = [
  { value: "1w", label: "Up to 1 week out" },
  { value: "2w", label: "Up to 2 weeks out" },
  { value: "30d", label: "Up to 30 days out" },
  { value: "60d", label: "Up to 60 days out" }
];

const FIRST_FOLLOW_UP_OPTIONS: IntakeChoiceOption[] = [
  { value: "2h", label: "After 2 hours" },
  { value: "4h", label: "After 4 hours" },
  { value: "same_day", label: "Later the same day" },
  { value: "next_morning", label: "The next morning" }
];

const SECOND_FOLLOW_UP_OPTIONS: IntakeChoiceOption[] = [
  { value: "next_day", label: "The next day" },
  { value: "2d", label: "After 2 days" },
  { value: "3d", label: "After 3 days" },
  { value: "1w", label: "After a week" }
];

const HANDOFF_AFTER_OPTIONS: IntakeChoiceOption[] = [
  { value: "2_attempts", label: "After 2 unanswered follow-ups" },
  { value: "3_attempts", label: "After 3 unanswered follow-ups" },
  { value: "5_attempts", label: "After 5 unanswered follow-ups" }
];

const NEVER_HANDLE_OPTIONS: IntakeChoiceOption[] = [
  { value: "pricing", label: "Quoting prices or discounts" },
  { value: "professional_advice", label: "Professional / licensed advice" },
  { value: "complaints", label: "Complaints or disputes" },
  { value: "cancellations", label: "Cancellations or refunds" },
  { value: "legal_medical", label: "Legal or medical questions" },
  { value: "payments", label: "Taking payments" },
  { value: "other", label: "Other (describe below)" }
];

const CONSENT_OPTIONS: IntakeChoiceOption[] = [
  { value: "yes", label: "Yes, our lead forms include text/call consent wording" },
  { value: "not_yet", label: "Not yet — we'd like help adding it" }
];

// ── Answers schema (server-side validation of the public submission) ───────

function enumOf(options: IntakeChoiceOption[]) {
  const values = options.map((o) => o.value);
  return z.enum(values as [string, ...string[]]);
}

export const intakeAnswersSchema = z.object({
  business_name: z.string().trim().min(1).max(200),
  industry: enumOf(INDUSTRY_OPTIONS),
  industry_other: z.string().trim().max(120).optional().default(""),
  website: z.string().trim().max(300).optional().default(""),
  business_hours: z.string().trim().min(1).max(200),
  team: z.string().trim().min(1).max(2000),
  lead_sources: z.array(enumOf(LEAD_SOURCE_OPTIONS)).min(1).max(LEAD_SOURCE_OPTIONS.length),
  lead_sources_other: z.string().trim().max(200).optional().default(""),
  tone: enumOf(TONE_OPTIONS),
  greeting: z.string().trim().max(500).optional().default(""),
  qualification_questions: z.string().trim().max(1000).optional().default(""),
  appointment_length: enumOf(APPOINTMENT_LENGTH_OPTIONS),
  appointment_buffer: enumOf(APPOINTMENT_BUFFER_OPTIONS),
  booking_notice: enumOf(BOOKING_NOTICE_OPTIONS),
  booking_window: enumOf(BOOKING_WINDOW_OPTIONS),
  first_follow_up: enumOf(FIRST_FOLLOW_UP_OPTIONS),
  second_follow_up: enumOf(SECOND_FOLLOW_UP_OPTIONS),
  handoff_after: enumOf(HANDOFF_AFTER_OPTIONS),
  never_handle: z.array(enumOf(NEVER_HANDLE_OPTIONS)).max(NEVER_HANDLE_OPTIONS.length).default([]),
  never_handle_other: z.string().trim().max(300).optional().default(""),
  consent_confirmed: enumOf(CONSENT_OPTIONS),
  notes: z.string().trim().max(1000).optional().default("")
});

export type IntakeAnswers = z.infer<typeof intakeAnswersSchema>;

// ── Industry presets (suggested wording the prospect can tweak) ────────────

export type IndustryPreset = {
  greeting: string;
  qualificationQuestions: string[];
};

export const INDUSTRY_PRESETS: Record<string, IndustryPreset> = {
  real_estate: {
    greeting:
      "Hi {name}! Thanks for reaching out about your home search. I'll help get you connected with one of our agents.",
    qualificationQuestions: [
      "Are you looking to buy, sell, or both?",
      "What area are you interested in?",
      "Anything you'd like your agent to know before they call?"
    ]
  },
  insurance: {
    greeting:
      "Hi {name}! Thanks for requesting a quote. I'll help get you connected with one of our licensed advisors.",
    qualificationQuestions: [
      "What prompted you to shop around today?",
      "Approximately when does your current policy renew?",
      "Anything you'd like your advisor to know before they call?"
    ]
  },
  home_services: {
    greeting:
      "Hi {name}! Thanks for contacting us. I'll help get your project scheduled with one of our technicians.",
    qualificationQuestions: [
      "What do you need help with?",
      "How soon are you hoping to get it done?",
      "Anything we should know before we call?"
    ]
  },
  legal: {
    greeting:
      "Hi {name}! Thanks for reaching out. I'll help arrange a consultation with one of our attorneys.",
    qualificationQuestions: [
      "What kind of matter can we help you with?",
      "Is there a deadline or court date we should know about?",
      "Anything you'd like the attorney to know before your consultation?"
    ]
  },
  health_wellness: {
    greeting:
      "Hi {name}! Thanks for getting in touch. I'll help you book a visit with our team.",
    qualificationQuestions: [
      "What would you like to come in for?",
      "Do you prefer mornings, afternoons, or evenings?",
      "Anything we should know before your visit?"
    ]
  },
  other: {
    greeting:
      "Hi {name}! Thanks for reaching out. I'll help get you connected with the right person on our team.",
    qualificationQuestions: [
      "What can we help you with today?",
      "How soon are you hoping to get started?",
      "Anything you'd like us to know before we call?"
    ]
  }
};

// ── Questionnaire definition (drives the public form) ──────────────────────

export const INTAKE_QUESTIONS: IntakeQuestion[] = [
  {
    id: "business_name",
    section: "About your business",
    label: "Business name",
    type: "text",
    placeholder: "Acme Home Services",
    required: true,
    maxLength: 200
  },
  {
    id: "industry",
    section: "About your business",
    label: "What industry are you in?",
    help: "We'll pre-fill suggested wording you can change.",
    type: "choice",
    options: INDUSTRY_OPTIONS,
    required: true
  },
  {
    id: "industry_other",
    section: "About your business",
    label: "If other, what do you do?",
    type: "text",
    placeholder: "e.g. Landscaping design",
    required: false,
    maxLength: 120
  },
  {
    id: "website",
    section: "About your business",
    label: "Website (optional)",
    type: "text",
    placeholder: "https://…",
    required: false,
    maxLength: 300
  },
  {
    id: "business_hours",
    section: "About your business",
    label: "Business hours",
    type: "text",
    placeholder: "Mon–Fri 9am–5pm",
    required: true,
    maxLength: 200
  },
  {
    id: "team",
    section: "Your team",
    label: "Who should the assistant hand leads to?",
    help: "One person per line: name and mobile number.",
    type: "textarea",
    placeholder: "Jane Smith — 555-123-4567\nJohn Doe — 555-987-6543",
    required: true,
    maxLength: 2000
  },
  {
    id: "lead_sources",
    section: "Where your leads come from",
    label: "Where do your leads come from today?",
    help: "Check all that apply.",
    type: "multi",
    options: LEAD_SOURCE_OPTIONS,
    required: true
  },
  {
    id: "lead_sources_other",
    section: "Where your leads come from",
    label: "Other lead sources",
    type: "text",
    placeholder: "e.g. Trade shows",
    required: false,
    maxLength: 200
  },
  {
    id: "tone",
    section: "The first message",
    label: "How should the assistant sound?",
    type: "choice",
    options: TONE_OPTIONS,
    required: true
  },
  {
    id: "greeting",
    section: "The first message",
    label: "The first text a new lead receives",
    help: "Leave blank to use our suggested wording for your industry. {name} is replaced with the lead's name.",
    type: "textarea",
    placeholder: "Hi {name}! Thanks for reaching out…",
    required: false,
    maxLength: 500
  },
  {
    id: "qualification_questions",
    section: "The first message",
    label: "Up to 3 questions the assistant may ask",
    help: "One per line, 3 at most — fewer questions means fewer leads lost. Leave blank to use our suggestions.",
    type: "textarea",
    placeholder: "What can we help you with?\nHow soon are you hoping to get started?",
    required: false,
    maxLength: 1000
  },
  {
    id: "appointment_length",
    section: "Appointments",
    label: "How long is a typical appointment?",
    type: "choice",
    options: APPOINTMENT_LENGTH_OPTIONS,
    required: true
  },
  {
    id: "appointment_buffer",
    section: "Appointments",
    label: "Breathing room between appointments?",
    type: "choice",
    options: APPOINTMENT_BUFFER_OPTIONS,
    required: true
  },
  {
    id: "booking_notice",
    section: "Appointments",
    label: "How soon can a new lead book?",
    type: "choice",
    options: BOOKING_NOTICE_OPTIONS,
    required: true
  },
  {
    id: "booking_window",
    section: "Appointments",
    label: "How far out can they book?",
    type: "choice",
    options: BOOKING_WINDOW_OPTIONS,
    required: true
  },
  {
    id: "first_follow_up",
    section: "Follow-up schedule",
    label: "If a lead doesn't reply, when should the assistant nudge them first?",
    type: "choice",
    options: FIRST_FOLLOW_UP_OPTIONS,
    required: true
  },
  {
    id: "second_follow_up",
    section: "Follow-up schedule",
    label: "And if they still don't reply, when's the second nudge?",
    type: "choice",
    options: SECOND_FOLLOW_UP_OPTIONS,
    required: true
  },
  {
    id: "handoff_after",
    section: "Follow-up schedule",
    label: "When should a quiet lead be flagged for a personal touch?",
    type: "choice",
    options: HANDOFF_AFTER_OPTIONS,
    required: true
  },
  {
    id: "never_handle",
    section: "When a human takes over",
    label: "Which topics should ALWAYS go straight to a person?",
    help: "Check all that apply. The assistant hands these off immediately.",
    type: "multi",
    options: NEVER_HANDLE_OPTIONS,
    required: false
  },
  {
    id: "never_handle_other",
    section: "When a human takes over",
    label: "Anything else the assistant should never handle?",
    type: "text",
    placeholder: "e.g. Warranty claims",
    required: false,
    maxLength: 300
  },
  {
    id: "consent_confirmed",
    section: "Compliance",
    label: "Do your lead forms include consent to text and call?",
    help: "Required for automated text messages (TCPA).",
    type: "choice",
    options: CONSENT_OPTIONS,
    required: true
  },
  {
    id: "notes",
    section: "Anything else",
    label: "Anything else we should know for your build?",
    type: "textarea",
    placeholder: "Special requests, systems you already use, busy seasons…",
    required: false,
    maxLength: 1000
  }
];

// ── Rendering ───────────────────────────────────────────────────────────────

export type DocSection = { heading: string; lines: string[] };
export type WhiteGloveDoc = { title: string; intro: string; sections: DocSection[] };

function labelOf(options: IntakeChoiceOption[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * Map multi-choice values to labels, appending free-text "other" detail.
 * A checked "other" with no description still shows up as "Other" — a
 * prospect's selection is never silently dropped from the document.
 */
function multiLabels(
  options: IntakeChoiceOption[],
  values: string[],
  otherText: string
): string[] {
  const labels = values
    .filter((v) => v !== "other")
    .map((v) => labelOf(options, v));
  if (otherText) labels.push(otherText);
  else if (values.includes("other")) labels.push("Other");
  return labels;
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Merge the prospect's answers into the structured build document. The
 * markdown (`renderWhiteGloveDoc`) and the print view both come from this.
 */
export function renderWhiteGloveDocSections(answers: IntakeAnswers): WhiteGloveDoc {
  const preset = INDUSTRY_PRESETS[answers.industry];
  const industryLabel =
    answers.industry === "other" && answers.industry_other
      ? answers.industry_other
      : labelOf(INDUSTRY_OPTIONS, answers.industry);
  const greeting = answers.greeting || preset.greeting;
  const questions = splitLines(answers.qualification_questions).slice(0, 3);
  const qualification = questions.length > 0 ? questions : preset.qualificationQuestions;
  const neverHandle = multiLabels(
    NEVER_HANDLE_OPTIONS,
    answers.never_handle,
    answers.never_handle_other
  );
  const leadSources = multiLabels(
    LEAD_SOURCE_OPTIONS,
    answers.lead_sources,
    answers.lead_sources_other
  );

  const sections: DocSection[] = [
    {
      heading: "1. About the business",
      lines: [
        `Business: ${answers.business_name}`,
        `Industry: ${industryLabel}`,
        `Website: ${answers.website || "—"}`,
        `Business hours: ${answers.business_hours}`
      ]
    },
    {
      heading: "2. Team & handoffs",
      lines: [
        "Leads are handed to (in order):",
        ...splitLines(answers.team).map((m) => `• ${m}`)
      ]
    },
    {
      heading: "3. Lead sources",
      lines: leadSources.map((s) => `• ${s}`)
    },
    {
      heading: "4. The first message",
      lines: [
        `Tone: ${labelOf(TONE_OPTIONS, answers.tone)}`,
        `Greeting (sent within 60 seconds of a new lead): "${greeting}"`,
        "The assistant may ask AT MOST these questions before booking:",
        ...qualification.map((q, i) => `${i + 1}. ${q}`),
        "If the lead asks to talk to someone, the assistant stops asking and books immediately."
      ]
    },
    {
      heading: "5. Appointments",
      lines: [
        `Appointment length: ${labelOf(APPOINTMENT_LENGTH_OPTIONS, answers.appointment_length)}`,
        `Buffer: ${labelOf(APPOINTMENT_BUFFER_OPTIONS, answers.appointment_buffer)}`,
        `Earliest booking: ${labelOf(BOOKING_NOTICE_OPTIONS, answers.booking_notice)}`,
        `Booking window: ${labelOf(BOOKING_WINDOW_OPTIONS, answers.booking_window)}`
      ]
    },
    {
      heading: "6. Follow-up schedule (no lead is ever forgotten)",
      lines: [
        `First nudge: ${labelOf(FIRST_FOLLOW_UP_OPTIONS, answers.first_follow_up)}`,
        `Second nudge: ${labelOf(SECOND_FOLLOW_UP_OPTIONS, answers.second_follow_up)}`,
        `Personal-touch flag: ${labelOf(HANDOFF_AFTER_OPTIONS, answers.handoff_after)}`,
        "Quiet leads are marked inactive, never deleted — if they reply weeks later, the conversation resumes where it left off."
      ]
    },
    {
      heading: "7. When a human takes over",
      lines: [
        "The assistant immediately hands off (never improvises) on:",
        ...(neverHandle.length > 0 ? neverHandle.map((t) => `• ${t}`) : ["• (none selected)"]),
        "• Any time the lead asks for a person",
        "• Any time the lead sounds frustrated"
      ]
    },
    {
      heading: "8. Compliance",
      lines: [
        `Lead-form text/call consent wording: ${labelOf(CONSENT_OPTIONS, answers.consent_confirmed)}`,
        "STOP / HELP replies are always honored automatically."
      ]
    },
    {
      heading: "9. Notes",
      lines: [answers.notes || "—"]
    },
    {
      heading: "10. Installation checklist (completed by our team)",
      lines: [
        "☐ Account created and server provisioned",
        "☐ Business phone number assigned and tested",
        "☐ Assistant personality configured from this document",
        "☐ Team calendar(s) connected",
        "☐ Lead sources connected and a test lead sent end-to-end",
        "☐ First-message wording approved by the customer",
        "☐ Follow-up schedule configured as above",
        "☐ Go-live"
      ]
    },
    {
      heading: "11. Go-live acceptance (both sides confirm)",
      lines: [
        "☐ A test lead received a text within 60 seconds",
        "☐ Every lead shows a clear status at all times",
        "☐ Follow-up nudges fire on the agreed schedule",
        "☐ Handoff topics reach a person immediately",
        "☐ Opt-out (STOP) is honored",
        "",
        "Customer signature: ______________________    Date: __________",
        "Installer signature: ______________________    Date: __________"
      ]
    }
  ];

  return {
    title: `White-Glove Build & Installation — ${answers.business_name}`,
    intro:
      "This document is the single source of truth for your white-glove build. " +
      "It captures how your AI assistant greets leads, books appointments, follows up, " +
      "and hands conversations to your team.",
    sections
  };
}

/** The finished document as markdown (download / copy). */
export function renderWhiteGloveDoc(answers: IntakeAnswers): string {
  const doc = renderWhiteGloveDocSections(answers);
  const parts = [
    `# ${doc.title}`,
    doc.intro,
    ...doc.sections.map((s) => `## ${s.heading}\n\n${s.lines.join("\n")}`)
  ];
  return parts.join("\n\n");
}
