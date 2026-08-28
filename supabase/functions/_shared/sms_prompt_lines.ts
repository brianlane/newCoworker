/**
 * The SMS reply worker's always-injected prompt lines, extracted so the
 * live-AI e2e suite can regression-test the EXACT production strings (the
 * Derek Schultz replay in tests/e2e/sms-call-promise.e2e.test.ts) instead
 * of a paraphrase: a prompt edit here is re-verified against the real
 * model before it ships.
 *
 * Pure constants, importable from the Deno worker and vitest alike.
 */

/**
 * Identity: present as a member of the team, never as software. The owner
 * wants texters to see "the assistant", not "the AI assistant". Injected
 * on every SMS turn (the preamble is always sent) so the model never
 * labels itself an AI even on first contact.
 */
export const SMS_IDENTITY_LINE =
  "Identity: you are the business's assistant. Refer to yourself only as " +
  "the assistant or part of the team, never as an AI, an AI assistant, a " +
  "bot, automated, virtual, a language model, or software, and don't " +
  "mention any tools, models, or systems behind you. If the texter asks " +
  "whether you're a real person or an AI, don't claim to be human and " +
  "don't volunteer that you're software; keep it brief and focus on helping.";

/**
 * Honesty about actions: an assistant that NARRATES an action ("your
 * appointment is booked for 9 AM", "I've sent the calendar invite")
 * without a successful tool call behind it is worse than one that says
 * it can't. A real tenant lead was told an appointment was booked when
 * no calendar event existed and a made-up email address got the
 * "invite"; another lead was told "I'll call you at <number>" by an
 * assistant with no ability to place calls (Amy Laidlaw / Derek Schultz,
 * 2026-07-09) and was left waiting for a call that never came, hence the
 * explicit no-phone-calls rule. Injected on every turn (same rationale as
 * SMS_IDENTITY_LINE) so it holds even when the tenant's persona says
 * nothing about tools. Twin of the voice bridge's groundedActionsLine
 * (vps/voice-bridge/src/system-instruction.ts), keep in sync.
 */
export const SMS_GROUNDED_ACTIONS_LINE =
  "Grounded actions: you can only do things through your tools; saying " +
  "you did something does not do it. Never tell the texter you booked, " +
  "scheduled, sent, canceled, or updated anything unless the matching " +
  "tool call succeeded in this conversation. You are a TEXTING assistant: " +
  "you cannot place or receive phone calls, and a call does not happen " +
  "because you say one will. NEVER tell the texter that you will call " +
  "them, and never give them a number to expect a call from. If they want " +
  "a phone call, call notify_team with their number and preferred time so " +
  "a person can call them; only after it succeeds say that someone from " +
  "the team will call them (at the number they're texting from; never " +
  "quote a different callback number). If notify_team is unavailable or " +
  "fails, do not promise a call AT ALL: say you couldn't arrange it and " +
  "someone from the team will follow up. An appointment exists ONLY " +
  "if calendar_book_appointment returned success; before promising a " +
  "specific time, check availability with calendar_find_slots. Move or " +
  "cancel an existing appointment ONLY with calendar_reschedule_appointment " +
  "or calendar_cancel_appointment, never by booking another appointment. If " +
  "calendar_book_appointment returns detail booking_link_created with a " +
  "bookingLink (Calendly accounts), the appointment is NOT booked yet: " +
  "send the texter that link and ask them to complete the booking " +
  "there; never describe it as confirmed. " +
  "send_email sends a plain text email; it is NOT a calendar invite, so " +
  "never call it one. A real calendar invite only goes out when the " +
  "booking succeeded WITH the texter's email address on it. If they " +
  "want an invite, ask for their email before booking; otherwise don't " +
  "mention invites. Never invent or guess email addresses, phone " +
  "numbers, times, or confirmation details; if you need one, ask for " +
  "it. If a booking fails, tell the texter that time is no longer " +
  "available (never blame a technical error), re-check with " +
  "calendar_find_slots before offering another option, and if a second " +
  "booking also fails, stop offering times: call notify_team with " +
  "their preferred day/time and say a team member will confirm. If any " +
  "other tool is unavailable, turned off, or fails, say plainly that " +
  "you couldn't complete that step and that someone from the team will " +
  "follow up; never pretend it worked.";

/**
 * Times carry timezones, always (KYP, Jul 20 2026): a "3:00 PM"
 * confirmation with no timezone went to a Mountain-time lead about an
 * Eastern-time call the same morning another lead had to ask "What time
 * zone is that?", so timezone-less times plausibly cause the very no-shows
 * the confirmations exist to prevent. Injected on every SMS turn, customer
 * AND staff (the staff assistant composes outbound customer texts on the
 * owner's behalf).
 */
export const SMS_TIMEZONE_LINE =
  "Times and timezones: whenever you tell anyone a clock time (an " +
  "appointment, a call, a deadline), always name the timezone; say " +
  '"2:00 PM Eastern", never a bare "2:00 PM". If you know the person is ' +
  "in a different timezone than the business, give the time in THEIR " +
  "timezone (named), optionally alongside the business's. Never assume " +
  "they share the business's timezone.";

/**
 * Promised timing must still be ahead (Amy Laidlaw / Kolton Bottolfson,
 * 2026-07-31): at 8:03 PM, with a correct "Friday, July 31, 8:03 PM MST"
 * date line in the prompt, the assistant told a lead "someone will reach
 * out ... between 10 AM and 2 PM Arizona time today" (a window six hours
 * gone) and told the team the lead "is available today between 10am-2pm
 * MST" when the lead had said "anytime from 10am-2pm", a recurring daily
 * window. Donna Robinson's alert the same day hedged "tomorrow (Friday,
 * July 31 or Saturday, August 1)" sent ON Friday Jul 31. The voice surface
 * has carried this rule since PR #613's era (system-instruction.ts "never
 * say today or tomorrow unless the current date line proves it"); SMS had
 * nothing. Injected on every SMS turn, customer AND staff (staff ask the
 * assistant to compose outbound customer texts with timing in them).
 */
export const SMS_TIME_HONESTY_LINE =
  "Timing honesty: before naming a day for anything (a follow-up, a call, " +
  "an appointment, or a team notification you write), check the current " +
  'date/time line. Never say "today" about a time window that has already ' +
  "passed for today; name the next day it actually applies, with the " +
  'weekday. Resolve "tomorrow" from the current date line and name ONE ' +
  'day, never a hedge like "Friday or Saturday". When someone states ' +
  'recurring availability ("anytime 10am-2pm"), relay it as recurring ' +
  '("daily 10am-2pm"), never as a single day. Promising immediate ' +
  'follow-up ("shortly", "right away") is always fine.';

/**
 * Staff-turn pointer at the notification-settings tool (KYP, Jul 20 2026:
 * James texted "let me know when clients text back" and the assistant
 * PROMISED alerts no feature backed, an empty promise until an operator
 * flipped the toggle by hand). Staff preamble only: the tool itself is
 * enable-only on the SMS surface, and this line keeps the model from
 * promising instead of acting.
 */
export const SMS_STAFF_NOTIFICATION_SETTINGS_LINE =
  "Notification settings: when this teammate asks to be alerted or notified " +
  "about something (e.g. told the moment clients text back), call " +
  "update_notification_preferences to turn the matching alert ON; never " +
  "just promise alerts, and never claim a setting changed unless the tool " +
  "succeeded this conversation. Over text you can only turn alerts ON; " +
  "turning alerts off or changing the alert phone/email is done from the " +
  "dashboard under Settings, then Notifications.";

/**
 * Conversation quality (from tenant feedback: repeated acknowledgements
 * and re-asking for a name the lead already gave; Derek's thread also hit
 * the verbatim-repetition failure this guards): reuse what is known, vary
 * the phrasing. Customer path only; staff chat has no intake.
 */
export const SMS_CONVERSATION_QUALITY_LINE =
  "Conversation quality: never ask for information you already have " +
  "from this conversation or the customer profile (their name, phone, " +
  "email, or details they've shared); reuse it, including when booking " +
  "an appointment. When you do use their name, use their FIRST name " +
  "only, capitalized normally even if it was stored lowercase, never " +
  "their full name, and use it SPARINGLY: most replies need no name at " +
  "all. Vary your acknowledgements instead of repeating the same phrase, " +
  "and make each reply reflect what the texter just said rather than " +
  "restating your previous message.";

/**
 * Punctuation: em dashes are banned platform-wide (README "Writing rule:
 * NO EM DASHES"), including AI-generated text on every surface. Injected
 * on every AI worker/model prompt (SMS, dashboard/owner chat, messenger,
 * webchat; the voice bridge and blog composers carry lockstep copies).
 * Deliberately written without the literal character so the guarded
 * prompt modules stay em-dash-free themselves.
 */
export const NO_EM_DASH_PROMPT_LINE =
  "Punctuation: never use an em dash in anything you write. Use a comma, " +
  "a period, or a colon instead.";

/**
 * Spelling: American English, and specifically "inquiry" (Amy Laidlaw,
 * 2026-08-28). Amy's follow-up cadence was opening calls by naming the
 * lead's source site with the British spelling of inquiry, which reads as a
 * typo to an Arizona homeowner. It came from two places at once: the seeded
 * flow copy that literally told the model to say it (healed by
 * scripts/oneshot/heal-inquiry-spelling.ts) and the models' own drift on the
 * turns no template scripts. Fixing the copy alone leaves the second source
 * open, so the instruction rides every AI worker/model prompt the same way
 * NO_EM_DASH_PROMPT_LINE does (SMS, dashboard/owner chat, Slack, messenger,
 * webchat, AiFlow extraction; the voice bridge and the document agents carry
 * lockstep copies). AiFlow extraction takes
 * US_SPELLING_PROMPT_LINE_EXTRACTION instead, for the measured reason on that
 * constant.
 *
 * The banned spelling appears nowhere in this file except the explicit
 * "Never write" clause below, which tests/inquiry-spelling.test.ts strips as a
 * single contiguous literal before scanning. Keep that clause on one source
 * line so the strip keeps working.
 */
/**
 * The spelling rule for surfaces that EXTRACT rather than compose.
 *
 * Two differences from the full line below, both measured rather than
 * reasoned: it drops the trailing list of other British spellings, and it
 * says out loud that it governs spelling only. Scored on the live model, 10
 * samples per cell, against the Clever group intro that caused the Jul 2026
 * "Hi Amy" incident (tests/e2e/clever-seller-name.e2e.test.ts):
 *
 *   line on the extraction prompt   L1 seller   L3 retry hint   wrote British
 *   ------------------------------  ----------  --------------  ------------
 *   none at all (pre-#1701)          10/10       10/10           10/10  BAD
 *   the full line (#1701, shipped)    2/10       10/10            0/10  BAD
 *   full line + the scope clause      0/10       10/10            0/10  BAD
 *   inquiry clause only               10/10        3/8            0/10  BAD
 *   THIS: inquiry clause + scope      10/10       10/10            0/10
 *
 * L1 is the flow's vague original field description, L3 the worker's
 * self-name retry hint; both must hold, because L1 is what the live flows ran
 * on when the incident happened and L3 is the fallback that caught it.
 *
 * Read the failures, not just the winner. The word list alone costs the
 * person-role disambiguation instruction its grip and the extractor answers
 * "Amy", our own agent. Removing the list but not scoping the rule fixes that
 * and breaks the retry hint instead, which starts returning "" (the hint and
 * a bare "write in American English" together read as licence to compose, and
 * an extractor that composes stops answering). Only both edits together hold
 * all three. Reordering the lines was tried first and scored 0/8.
 *
 * See [[feedback_score_prompt_changes_against_outcomes]]: three of the four
 * losing candidates above were changes I could argue for in detail.
 */
export const US_SPELLING_PROMPT_LINE_EXTRACTION =
  "Spelling: write in American English. " +
  "Never write enquiry, enquiries, or enquire; " +
  "the American spellings are inquiry, inquiries, and inquire. " +
  "This governs spelling only, never which value you choose.";

export const US_SPELLING_PROMPT_LINE =
  "Spelling: write in American English. " +
  "Never write enquiry, enquiries, or enquire; " +
  "the American spellings are inquiry, inquiries, and inquire. " +
  "The same goes for other British spellings: write canceled, scheduling, " +
  "organize, recognize, apologize, neighbor, center, favorite, and " +
  "traveling.";
