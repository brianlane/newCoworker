/**
 * White-glove intake → tenant configuration (pure mapping half).
 *
 * `buildIntakeApplyPlan` turns a COMPLETED intake's answers into everything
 * the apply service writes to the tenant:
 *
 *   - a soul.md section (greeting, qualification questions, handoff topics,
 *     tone notes) and a memory.md section (scheduling rules, team, lead
 *     sources, follow-up cadence), both wrapped in marker comments so a
 *     re-apply replaces ONLY its own block and never an owner's edits;
 *   - a best-effort parse of the free-text business hours into the
 *     `businesses.business_hours` jsonb shape (unparseable text is skipped
 *     there but always lands in the memory section verbatim);
 *   - a "Lead follow-up" AiFlow definition implementing the intake's
 *     greeting + nudge cadence + personal-touch flag, validated through
 *     `parseAiFlowDefinition` like every code-defined template.
 *
 * Everything here is pure (no DB, no next/server) so the admin panel can
 * import it client-side to PREVIEW what an apply will write, and unit tests
 * can cover the mapping without mocks. The DB half lives in
 * `src/lib/white-glove/apply-service.ts`.
 */
import type { AiFlowTemplate } from "@/lib/ai-flows/templates";
import { parseAiFlowDefinition, VAR_NAME_PATTERN } from "@/lib/ai-flows/schema";
import type {
  BusinessDayHours,
  BusinessHours,
  BusinessHoursDay
} from "@/lib/business-profile/profile";
import { BUSINESS_HOURS_DAYS } from "@/lib/business-profile/profile";
import {
  presetForIndustry,
  type IntakeAnswers,
  type IntakeMeta
} from "@/lib/white-glove/template";

// ── Marker-delimited vault blocks ───────────────────────────────────────────

export const WHITE_GLOVE_BLOCK_START = "<!-- white-glove-build:start -->";
export const WHITE_GLOVE_BLOCK_END = "<!-- white-glove-build:end -->";

const BLOCK_RE = /<!-- white-glove-build:start -->[\s\S]*?<!-- white-glove-build:end -->/;

/** Wrap `content` in the white-glove markers. */
export function wrapWhiteGloveBlock(content: string): string {
  return `${WHITE_GLOVE_BLOCK_START}\n${content.trim()}\n${WHITE_GLOVE_BLOCK_END}`;
}

/**
 * Replace the existing white-glove block in `document` with `block` (already
 * wrapped), or append it when no well-formed block exists. Owner-authored
 * text outside the markers is never touched; a malformed block (start marker
 * without an end) is left alone and a fresh block is appended after it.
 */
export function replaceWhiteGloveBlock(document: string, block: string): string {
  if (BLOCK_RE.test(document)) {
    return document.replace(BLOCK_RE, block);
  }
  const base = document.trimEnd();
  return base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
}

// ── Choice-value → human/config mappings ────────────────────────────────────

/** Follow-up cadence choices → wait minutes ("next morning" ≈ 18h). */
const FIRST_FOLLOW_UP_MINUTES: Record<string, number> = {
  "2h": 120,
  "4h": 240,
  same_day: 300,
  next_morning: 1080
};

const SECOND_FOLLOW_UP_MINUTES: Record<string, number> = {
  next_day: 1440,
  "2d": 2880,
  "3d": 4320,
  "1w": 10080
};

const HANDOFF_AFTER_ATTEMPTS: Record<string, number> = {
  "2_attempts": 2,
  "3_attempts": 3,
  "5_attempts": 5
};

const FIRST_FOLLOW_UP_LABELS: Record<string, string> = {
  "2h": "after 2 hours",
  "4h": "after 4 hours",
  same_day: "later the same day",
  next_morning: "the next morning"
};

const SECOND_FOLLOW_UP_LABELS: Record<string, string> = {
  next_day: "the next day",
  "2d": "after 2 days",
  "3d": "after 3 days",
  "1w": "after a week"
};

const APPOINTMENT_LENGTH_LABELS: Record<string, string> = {
  "15": "15 minutes",
  "30": "30 minutes",
  "45": "45 minutes",
  "60": "1 hour"
};

const APPOINTMENT_BUFFER_LABELS: Record<string, string> = {
  none: "no buffer between appointments",
  "15": "15 minutes between appointments",
  "30": "30 minutes between appointments"
};

const BOOKING_NOTICE_LABELS: Record<string, string> = {
  asap: "same-day bookings are fine, even short notice",
  "2h": "book at least 2 hours ahead",
  next_day: "book the next business day at the earliest"
};

const BOOKING_WINDOW_LABELS: Record<string, string> = {
  "1w": "up to 1 week out",
  "2w": "up to 2 weeks out",
  "30d": "up to 30 days out",
  "60d": "up to 60 days out"
};

const NEVER_HANDLE_LABELS: Record<string, string> = {
  pricing: "Quoting prices or discounts",
  professional_advice: "Professional / licensed advice",
  complaints: "Complaints or disputes",
  cancellations: "Cancellations or refunds",
  legal_medical: "Legal or medical questions",
  payments: "Taking payments"
};

const LEAD_SOURCE_LABELS: Record<string, string> = {
  facebook_instagram: "Facebook / Instagram ads",
  website_form: "Website form",
  google: "Google ads / search",
  phone_calls: "Phone calls",
  referrals: "Referrals"
};

export function firstFollowUpMinutes(value: string): number {
  return FIRST_FOLLOW_UP_MINUTES[value] ?? 120;
}

export function secondFollowUpMinutes(value: string): number {
  return SECOND_FOLLOW_UP_MINUTES[value] ?? 1440;
}

export function handoffAfterAttempts(value: string): number {
  return HANDOFF_AFTER_ATTEMPTS[value] ?? 3;
}

// ── Business hours parsing ──────────────────────────────────────────────────

const DAY_TOKENS: Record<string, BusinessHoursDay> = {
  mon: "mon",
  monday: "mon",
  tue: "tue",
  tues: "tue",
  tuesday: "tue",
  wed: "wed",
  weds: "wed",
  wednesday: "wed",
  thu: "thu",
  thur: "thu",
  thurs: "thu",
  thursday: "thu",
  fri: "fri",
  friday: "fri",
  sat: "sat",
  saturday: "sat",
  sun: "sun",
  sunday: "sun"
};

const TIME_RANGE_RE =
  /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

function to24Hour(hour: number, meridiem: string | undefined): number | null {
  if (hour > 23) return null;
  if (!meridiem) return hour;
  if (hour < 1 || hour > 12) return null;
  if (meridiem === "am") return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Parse one segment's time range into 24h open/close. Meridiem inference for
 * shorthand like "9-5" (close rolls forward past noon) and "7 to 9pm" (open
 * borrows the close's meridiem when that keeps the range valid).
 */
function parseTimeRange(segment: string): { open: string; close: string } | null {
  const m = TIME_RANGE_RE.exec(segment);
  if (!m) return null;
  const [, h1Raw, m1Raw, mer1Raw, h2Raw, m2Raw, mer2Raw] = m;
  const h1 = Number(h1Raw);
  const h2 = Number(h2Raw);
  const min1 = m1Raw ? Number(m1Raw) : 0;
  const min2 = m2Raw ? Number(m2Raw) : 0;
  if (min1 > 59 || min2 > 59) return null;
  const mer1 = mer1Raw?.toLowerCase();
  const mer2 = mer2Raw?.toLowerCase();

  let close = to24Hour(h2, mer2);
  if (close === null) return null;
  let open: number | null;
  if (mer1) {
    open = to24Hour(h1, mer1);
  } else if (mer2) {
    // "7 to 9pm" → prefer the close's meridiem for the open when the range
    // stays valid (19–21); "11 to 6pm" falls back to the literal hour (11–18).
    const borrowed = to24Hour(h1, mer2);
    open = borrowed !== null && borrowed < close ? borrowed : to24Hour(h1, undefined);
  } else {
    open = to24Hour(h1, undefined);
  }
  if (open === null) return null;

  // No meridiem on the close: roll it past noon when needed ("9-5" → 17,
  // "9am to 5" → 17).
  if (!mer2 && close <= open && close + 12 <= 23) close += 12;
  if (open >= close) return null;
  const openTime = `${pad2(open)}:${pad2(min1)}`;
  const closeTime = `${pad2(close)}:${pad2(min2)}`;
  return { open: openTime, close: closeTime };
}

/** Expand a day spec found in a segment; null = no day spec present. */
function parseDaySpec(segment: string): BusinessHoursDay[] | null {
  const lower = segment.toLowerCase();
  if (/\b(every ?day|daily|7 days)\b/.test(lower)) return [...BUSINESS_HOURS_DAYS];
  if (/\bweekdays?\b/.test(lower)) return ["mon", "tue", "wed", "thu", "fri"];
  if (/\bweekends?\b/.test(lower)) return ["sat", "sun"];

  const dayToken = "(mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
  const rangeRe = new RegExp(`\\b${dayToken}\\s*(?:-|–|—|to|through|thru)\\s*${dayToken}\\b`, "i");
  const range = rangeRe.exec(lower);
  if (range) {
    // Every token the regex matches has a valid 3-letter prefix in DAY_TOKENS.
    const from = DAY_TOKENS[range[1].slice(0, 3)];
    const to = DAY_TOKENS[range[2].slice(0, 3)];
    const fromIdx = BUSINESS_HOURS_DAYS.indexOf(from);
    const toIdx = BUSINESS_HOURS_DAYS.indexOf(to);
    if (fromIdx <= toIdx) return BUSINESS_HOURS_DAYS.slice(fromIdx, toIdx + 1);
    // Wrap-around ranges like "Sat–Mon".
    return [...BUSINESS_HOURS_DAYS.slice(fromIdx), ...BUSINESS_HOURS_DAYS.slice(0, toIdx + 1)];
  }

  const singles: BusinessHoursDay[] = [];
  const singleRe = new RegExp(`\\b${dayToken}\\b`, "gi");
  for (const match of lower.matchAll(singleRe)) {
    const day = DAY_TOKENS[match[1].slice(0, 3)];
    if (!singles.includes(day)) singles.push(day);
  }
  return singles.length > 0 ? singles : null;
}

/**
 * Best-effort parse of the intake's free-text business hours ("11am to 6pm",
 * "Mon–Fri 9-5, Sat 10am–2pm") into the `businesses.business_hours` shape.
 * Segments without a day spec default to Monday–Friday. Returns null when
 * nothing usable parses — callers keep the raw text in memory.md either way.
 */
export function parseIntakeBusinessHours(text: string): BusinessHours | null {
  const out: BusinessHours = {};
  let any = false;
  // Segments split on list punctuation only — "Tuesday and Thursday 8:30am
  // to 12pm" is ONE segment whose day parser collects both days.
  for (const segment of text.split(/[,;\n]/)) {
    const range = parseTimeRange(segment);
    if (!range) continue;
    const days = parseDaySpec(segment) ?? ["mon", "tue", "wed", "thu", "fri"];
    for (const day of days) {
      out[day] = { open: range.open, close: range.close } satisfies BusinessDayHours;
      any = true;
    }
  }
  return any ? out : null;
}

// ── Greeting placeholders ───────────────────────────────────────────────────

/** Extra lead fields the greeting's `{placeholder}` tokens can add. */
const MAX_EXTRA_EXTRACT_FIELDS = 3;

const PLACEHOLDER_RE = /\{([^{}]{1,40})\}/g;

export type GreetingCompilation = {
  /** The greeting with `{x}` tokens rewritten to `{{vars.lead_x}}`. */
  body: string;
  /** Extra extract_text fields the placeholders require (beyond the base 4). */
  extraFields: Array<{ name: string; description: string }>;
};

/**
 * Rewrite the intake greeting's human placeholders into flow template vars:
 * `{name}` → the base `lead_name` var; any other `{token}` becomes an extra
 * Gemini extraction field (`lead_<token>`) with a graceful fallback phrase,
 * capped at {@link MAX_EXTRA_EXTRACT_FIELDS} (extras beyond the cap and
 * unusable tokens degrade to their literal text without braces).
 */
export function compileGreetingPlaceholders(greeting: string): GreetingCompilation {
  const extraFields: Array<{ name: string; description: string }> = [];
  const body = greeting.replace(PLACEHOLDER_RE, (whole, rawToken: string) => {
    const token = rawToken.trim();
    if (token.toLowerCase() === "name") return "{{vars.lead_name}}";
    const slug = token.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const varName = `lead_${slug}`;
    if (!slug || !VAR_NAME_PATTERN.test(varName)) return token;
    const existing = extraFields.find((f) => f.name === varName);
    if (!existing && extraFields.length >= MAX_EXTRA_EXTRACT_FIELDS) return token;
    if (!existing) {
      extraFields.push({
        name: varName,
        description:
          `The lead's ${token} from the lead form; if not provided, a short natural ` +
          `fallback like "your ${token}"`
      });
    }
    return `{{vars.${varName}}}`;
  });
  return { body, extraFields };
}

/** First booking/scheduling link in the greeting (schemeless links included). */
export function firstLinkInGreeting(greeting: string): string | null {
  const m = /(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+\/[^\s"'<>)]+/i.exec(greeting);
  return m ? m[0].replace(/[.,!?]+$/, "") : null;
}

// ── Follow-up flow template ─────────────────────────────────────────────────

export const INTAKE_FOLLOW_UP_FLOW_NAME = "Lead follow-up (white-glove build)";

type FlowStepJson = Record<string, unknown>;

function nudgeBody(attempt: number, bookingLink: string | null): string {
  if (attempt === 1) {
    return (
      "Hey {{vars.lead_name}}, just floating this back up — happy to answer any " +
      "questions whenever you're ready." +
      (bookingLink ? ` You can grab a time here: ${bookingLink}` : "")
    );
  }
  if (attempt === 2) {
    return (
      "Hi {{vars.lead_name}}, I don't want you to slip through the cracks!" +
      (bookingLink
        ? ` Booking only takes a minute: ${bookingLink}`
        : " Want me to help you get scheduled?")
    );
  }
  return (
    "Hey {{vars.lead_name}}, still here whenever you're ready" +
    (bookingLink ? ` — grab a time that works: ${bookingLink}` : ".")
  );
}

/**
 * Build the intake-configured "Lead follow-up" flow: webhook lead in →
 * greeting within seconds → nudges on the agreed cadence → after N
 * unanswered follow-ups, flag the owner for a personal touch and tag the
 * contact Inactive (never deleted). A trailing goal step watching
 * replied/appointment_booked stops nurturing anyone who converts mid-chain.
 * Installed DISABLED so the owner approves the wording first.
 */
export function intakeFollowUpFlowTemplate(
  answers: IntakeAnswers,
  meta: IntakeMeta
): AiFlowTemplate {
  const preset = presetForIndustry(meta.industry);
  const greeting = compileGreetingPlaceholders(answers.greeting || preset.greeting);
  const bookingLink = firstLinkInGreeting(answers.greeting || preset.greeting);
  const attempts = handoffAfterAttempts(answers.handoff_after);
  const firstWait = firstFollowUpMinutes(answers.first_follow_up);
  const laterWait = secondFollowUpMinutes(answers.second_follow_up);

  const steps: FlowStepJson[] = [
    {
      id: "s_extract",
      type: "extract_text",
      fields: [
        { name: "lead_name", description: "The lead's full name" },
        { name: "lead_phone", description: "The lead's phone number, digits and + only" },
        { name: "lead_email", description: "The lead's email address" },
        {
          name: "lead_notes",
          description:
            "Everything else the lead provided: custom question answers, city, budget, " +
            "timeframe. 'none' if nothing."
        },
        ...greeting.extraFields
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
      id: "s_greet",
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body: greeting.body
    },
    {
      id: "s_notify_new",
      type: "notify_owner",
      message:
        "New lead: {{vars.lead_name}} — {{vars.lead_phone}} / {{vars.lead_email}}. " +
        "Details: {{vars.lead_notes}}. I sent them your greeting and I'm on follow-up duty."
    }
  ];

  for (let i = 1; i <= attempts; i++) {
    const replyVar = `reply_${i}`;
    steps.push({
      id: `s_wait_${i}`,
      type: "wait_for_reply",
      phoneVar: "lead_phone",
      saveAs: replyVar,
      timeoutMinutes: i === 1 ? firstWait : laterWait,
      // A reply anywhere in the chain skips every later wait/nudge (each
      // step is gated on the previous wait having timed out).
      ...(i > 1 ? { when: { var: `reply_${i - 1}`, equals: "no_reply" } } : {})
    });
    steps.push({
      id: `s_nudge_${i}`,
      type: "send_sms",
      to: "{{vars.lead_phone}}",
      body: nudgeBody(i, bookingLink),
      when: { var: replyVar, equals: "no_reply" }
    });
  }

  steps.push(
    {
      id: "s_wait_final",
      type: "wait_for_reply",
      phoneVar: "lead_phone",
      saveAs: "reply_final",
      timeoutMinutes: laterWait,
      when: { var: `reply_${attempts}`, equals: "no_reply" }
    },
    {
      id: "s_flag_owner",
      type: "notify_owner",
      message:
        `Personal touch needed: {{vars.lead_name}} ({{vars.lead_phone}}) hasn't replied ` +
        `to ${attempts} follow-ups. I've marked them Inactive — they're never deleted, ` +
        `and if they reply later the conversation picks right back up.`,
      when: { var: "reply_final", equals: "no_reply" }
    },
    {
      id: "s_mark_inactive",
      type: "update_contact",
      phoneVar: "lead_phone",
      addTags: ["Inactive"],
      when: { var: "reply_final", equals: "no_reply" }
    },
    {
      id: "s_goal",
      type: "goal",
      label: "Lead replied or booked",
      events: [{ kind: "replied" }, { kind: "appointment_booked" }]
    }
  );

  return {
    key: "white_glove_lead_follow_up",
    name: INTAKE_FOLLOW_UP_FLOW_NAME,
    definition: parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "webhook", conditions: [] },
      steps
    })
  };
}

// ── Vault sections ──────────────────────────────────────────────────────────

function labelList(values: string[], labels: Record<string, string>, other: string): string[] {
  const out = values.filter((v) => v !== "other").map((v) => labels[v] ?? v);
  if (other.trim()) out.push(other.trim());
  else if (values.includes("other")) out.push("Other");
  return out;
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** The soul.md white-glove section (greeting, qualification, handoffs, tone). */
export function renderIntakeSoulSection(answers: IntakeAnswers, meta: IntakeMeta): string {
  const preset = presetForIndustry(meta.industry);
  const greeting = answers.greeting || preset.greeting;
  const questions = splitLines(answers.qualification_questions).slice(0, 3);
  const qualification = questions.length > 0 ? questions : preset.qualificationQuestions;
  const neverHandle = labelList(
    answers.never_handle,
    NEVER_HANDLE_LABELS,
    answers.never_handle_other
  );

  const lines = [
    "## White-glove build (from the signed build document)",
    "",
    "### First message & qualification",
    `- Every new lead gets this greeting within 60 seconds: "${greeting}"`,
    "- Ask AT MOST these questions before booking (fewer questions means fewer leads lost):",
    ...qualification.map((q, i) => `  ${i + 1}. ${q}`),
    "- If the lead asks to talk to someone, stop asking questions and book immediately.",
    "",
    "### Hand off to a human immediately (never improvise) on:",
    ...(neverHandle.length > 0 ? neverHandle.map((t) => `- ${t}`) : ["- (no specific topics selected)"]),
    "- Any time the lead asks for a person.",
    "- Any time the lead sounds frustrated."
  ];

  if (answers.notes.trim()) {
    lines.push("", "### Tone & owner notes", answers.notes.trim());
  }
  return lines.join("\n");
}

/** The memory.md white-glove section (scheduling, team, sources, cadence). */
export function renderIntakeMemorySection(answers: IntakeAnswers): string {
  const teamLines = splitLines(answers.team);
  const leadSources = labelList(
    answers.lead_sources,
    LEAD_SOURCE_LABELS,
    answers.lead_sources_other
  );
  const attempts = handoffAfterAttempts(answers.handoff_after);

  return [
    "## White-glove build (from the signed build document)",
    "",
    "### Scheduling rules",
    `- Business hours: ${answers.business_hours}`,
    `- Appointment length: ${APPOINTMENT_LENGTH_LABELS[answers.appointment_length] ?? answers.appointment_length}`,
    `- Buffer: ${APPOINTMENT_BUFFER_LABELS[answers.appointment_buffer] ?? answers.appointment_buffer}`,
    `- Earliest booking: ${BOOKING_NOTICE_LABELS[answers.booking_notice] ?? answers.booking_notice}`,
    `- Booking window: ${BOOKING_WINDOW_LABELS[answers.booking_window] ?? answers.booking_window}`,
    "",
    "### Team & handoffs (in order)",
    ...(teamLines.length > 0 ? teamLines.map((t) => `- ${t}`) : ["- (not specified)"]),
    "",
    "### Lead sources",
    ...leadSources.map((s) => `- ${s}`),
    "",
    "### Follow-up schedule",
    `- First nudge ${FIRST_FOLLOW_UP_LABELS[answers.first_follow_up] ?? answers.first_follow_up}, second nudge ${SECOND_FOLLOW_UP_LABELS[answers.second_follow_up] ?? answers.second_follow_up}.`,
    `- Flag for a personal touch after ${attempts} unanswered follow-ups.`,
    "- Quiet leads are marked inactive, never deleted — if they reply weeks later, the conversation resumes where it left off.",
    "",
    "### Compliance",
    `- Lead-form text/call consent wording: ${answers.consent_confirmed === "yes" ? "in place" : "needs help adding it"}.`,
    "- STOP / HELP replies are always honored automatically."
  ].join("\n");
}

// ── The full apply plan ─────────────────────────────────────────────────────

export type IntakeApplyPlan = {
  /** Marker-wrapped soul.md block (replaceWhiteGloveBlock target). */
  soulBlock: string;
  /** Marker-wrapped memory.md block. */
  memoryBlock: string;
  /** Parsed hours for businesses.business_hours, or null (unparseable). */
  businessHours: BusinessHours | null;
  /** The configured follow-up flow (install disabled). */
  flow: AiFlowTemplate;
};

/** Everything an apply writes, derived purely from the intake's answers. */
export function buildIntakeApplyPlan(answers: IntakeAnswers, meta: IntakeMeta): IntakeApplyPlan {
  return {
    soulBlock: wrapWhiteGloveBlock(renderIntakeSoulSection(answers, meta)),
    memoryBlock: wrapWhiteGloveBlock(renderIntakeMemorySection(answers)),
    businessHours: parseIntakeBusinessHours(answers.business_hours),
    flow: intakeFollowUpFlowTemplate(answers, meta)
  };
}
