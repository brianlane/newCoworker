/**
 * Slack chat surface: prompt blocks and the fixed strings the coworker
 * posts into a workspace. The prompt side has two branches:
 *
 *   - OWNER: the verified business owner (users.info email matches the
 *     business owner email). The worker composes OWNER_PREAMBLE (the
 *     dashboard persona, which embeds NO_EM_DASH_PROMPT_LINE) plus
 *     SLACK_SURFACE_BLOCK, mirroring the owner-SMS operator route.
 *   - TEAM: any other workspace member. They get the team preamble below:
 *     helpful on business questions and drafting, no owner-power settings
 *     tools, no email sending, and honest about both.
 *
 * Fixed strings are locale-parameterized with an English default
 * (src/lib/i18n/email-copy.ts convention): Slack copy follows the owner's
 * UI language choice, never Accept-Language.
 */
import type { AppLocale } from "@/i18n/routing";
import {
  NO_EM_DASH_PROMPT_LINE,
  US_SPELLING_PROMPT_LINE
} from "../../../supabase/functions/_shared/sms_prompt_lines";

/** Replies must fit chat; Slack renders ~4k chars of text reliably. */
export const SLACK_REPLY_MAX_CHARS = 3900;

// Exported for the live-AI e2e suite: replays must run against the EXACT
// production string, not a paraphrase (SMS_SURFACE_BLOCK convention).
export const SLACK_SURFACE_BLOCK = `THIS CONVERSATION IS IN SLACK, inside the business's own workspace. You are talking with a member of the team, not a customer.
- Format for Slack: short paragraphs, *bold* for emphasis, bullet lines with "-", and <URL|label> for links. No markdown headings or tables.
- Keep replies under ${SLACK_REPLY_MAX_CHARS} characters.
- You HAVE working tools on this surface. Use them per your rules; never claim you can't act just because this is Slack.
- When you need a decision, ask ONE clear question and wait for the reply.`;

export const SLACK_TEAM_PREAMBLE = `You are the business's AI coworker, talking in Slack with a TEAM MEMBER (their identity comes from their Slack profile; do not ask them to prove who they are, and do not treat them as a customer).
Help them the way a sharp colleague would: answer questions about the business, look things up, check the calendar, draft copy, and take the actions your tools allow.
You are NOT talking to the business owner: account settings, notification preferences, roster changes, spam flags, and sending email are owner-only actions on this surface. If asked, say plainly that the owner can do it from the dashboard or by asking you in their own Slack DM.
Ground everything in what your tools return; when you do not know, say so instead of guessing.
${NO_EM_DASH_PROMPT_LINE}
${US_SPELLING_PROMPT_LINE}`;

const ONBOARDING: Record<AppLocale, string> = {
  en: "👋 I'm your business's New Coworker. Ask me about customers, bookings, and business questions, or have me draft something. Mention me in a channel with @New Coworker, or just DM me here.",
  es: "👋 Soy el New Coworker de tu negocio. Pregúntame por clientes, citas y dudas del negocio, o pídeme un borrador. Mencióname en un canal con @New Coworker, o escríbeme aquí directo."
};

const OVER_CAP: Record<AppLocale, string> = {
  en: "I've hit this month's AI budget for your business, so I have to sit this one out. The owner can raise the cap under Dashboard → Billing.",
  es: "Alcancé el presupuesto de IA de este mes para tu negocio, así que no puedo responder ahora. El dueño puede subir el límite en Dashboard → Billing."
};

const TIER_BLOCKED: Record<AppLocale, string> = {
  en: "Slack chat is part of the Standard and Enterprise plans. The owner can upgrade from Dashboard → Billing, and I'll be right here.",
  es: "El chat de Slack es parte de los planes Standard y Enterprise. El dueño puede mejorar el plan en Dashboard → Billing, y aquí estaré."
};

const TURN_FAILED: Record<AppLocale, string> = {
  en: "Something went wrong on my side and I couldn't finish that. Try me again in a moment.",
  es: "Algo falló de mi lado y no pude terminar. Inténtalo de nuevo en un momento."
};

function pick(map: Record<AppLocale, string>, locale: AppLocale): string {
  return map[locale] ?? map.en;
}

export function slackOnboardingMessage(locale: AppLocale = "en"): string {
  return pick(ONBOARDING, locale);
}

export function slackOverCapMessage(locale: AppLocale = "en"): string {
  return pick(OVER_CAP, locale);
}

export function slackTierBlockedMessage(locale: AppLocale = "en"): string {
  return pick(TIER_BLOCKED, locale);
}

export function slackTurnFailedMessage(locale: AppLocale = "en"): string {
  return pick(TURN_FAILED, locale);
}
