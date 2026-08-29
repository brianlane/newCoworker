/**
 * The Teams coworker surface: prompt blocks and the fixed strings the bot
 * posts into a tenant's Teams.
 *
 * Same two branches as every other owner surface: the verified OWNER gets
 * the dashboard persona, an identified teammate gets the team persona with
 * owner-power tools hard off, and anyone the platform cannot place gets
 * nothing.
 *
 * Fixed strings are locale-parameterized with an English default
 * (src/lib/i18n/email-copy.ts convention): copy follows the owner's UI
 * language choice, never Accept-Language.
 */
import type { AppLocale } from "@/i18n/routing";
import {
  NO_EM_DASH_PROMPT_LINE,
  US_SPELLING_PROMPT_LINE
} from "../../../supabase/functions/_shared/sms_prompt_lines";

/**
 * Teams renders long messages fine, but this is a chat thread rather than a
 * document. Sized with Slack's ceiling for the same reason: a reply nobody
 * scrolls to the end of was not delivered.
 */
export const TEAMS_REPLY_MAX_CHARS = 3900;

export const TEAMS_SURFACE_BLOCK = `THIS CONVERSATION IS IN MICROSOFT TEAMS, inside the business's own Microsoft 365 tenant. You are talking with a member of the team, not a customer. Their identity comes from their Microsoft account, so never ask them to prove who they are, never run the lead-intake script here, and never ask them for their contact details.
- Format for Teams: short paragraphs, **bold** for emphasis, bullet lines with "-". No markdown headings or tables.
- Keep replies under ${TEAMS_REPLY_MAX_CHARS} characters.
- You HAVE working tools on this surface. Use them per your rules; never claim you cannot act just because this is Teams.
- When you need a decision, ask ONE clear question and wait for the reply.`;

export const TEAMS_TEAM_PREAMBLE = `You are the business's AI coworker, talking in Microsoft Teams with a TEAM MEMBER (their identity comes from their Microsoft account; do not ask them to prove who they are, and do not treat them as a customer).
Help them the way a sharp colleague would: answer questions about the business, look things up, check the calendar, draft copy, and take the actions your tools allow.
You are NOT talking to the business owner: account settings, notification preferences, roster changes, spam flags, and sending email are owner-only actions on this surface. If asked, say plainly that the owner can do it from the dashboard or by messaging you themselves.
Ground everything in what your tools return; when you do not know, say so instead of guessing.
${NO_EM_DASH_PROMPT_LINE}
${US_SPELLING_PROMPT_LINE}`;

const ONBOARDING: Record<AppLocale, string> = {
  en: "👋 I'm your business's New Coworker. Ask me about customers, bookings, and business questions, or have me draft something. Your urgent alerts will arrive here too.",
  es: "👋 Soy el New Coworker de tu negocio. Pregúntame por clientes, citas y dudas del negocio, o pídeme un borrador. Tus avisos urgentes también llegarán aquí."
};

/**
 * Shown to someone the platform cannot place.
 *
 * Deliberately says nothing about the business. Our Entra app registration
 * is multi-tenant, so an unbound tenant can install the Teams app and
 * message us; confirming which business the bot serves would tell a stranger
 * something they did not know.
 */
const NEEDS_LINKING: Record<AppLocale, string> = {
  en: "Before I can help, someone from the business needs to connect this Microsoft Teams account. Ask them to open Settings, then Integrations, then Microsoft Teams.",
  es: "Antes de poder ayudarte, alguien del negocio tiene que conectar esta cuenta de Microsoft Teams. Pídele que abra Configuración, luego Integraciones y luego Microsoft Teams."
};

const OVER_CAP: Record<AppLocale, string> = {
  en: "I've hit this month's AI usage limit for the business, so I can't answer right now. The owner can raise it from the dashboard.",
  es: "He alcanzado el límite de uso de IA del negocio este mes, así que no puedo responder ahora. El propietario puede ampliarlo desde el panel."
};

const TIER_BLOCKED: Record<AppLocale, string> = {
  en: "The Microsoft Teams integration is available on Standard and Enterprise plans.",
  es: "La integración de Microsoft Teams está disponible en los planes Standard y Enterprise."
};

const TURN_FAILED: Record<AppLocale, string> = {
  en: "Something went wrong on my end and I couldn't finish that. Please try again.",
  es: "Algo ha fallado por mi parte y no he podido terminar. Inténtalo de nuevo."
};

const pick = (table: Record<AppLocale, string>, locale: AppLocale = "en"): string =>
  table[locale] ?? table.en;

export const teamsOnboardingMessage = (l?: AppLocale) => pick(ONBOARDING, l);
export const teamsNeedsLinkingMessage = (l?: AppLocale) => pick(NEEDS_LINKING, l);
export const teamsOverCapMessage = (l?: AppLocale) => pick(OVER_CAP, l);
export const teamsTierBlockedMessage = (l?: AppLocale) => pick(TIER_BLOCKED, l);
export const teamsTurnFailedMessage = (l?: AppLocale) => pick(TURN_FAILED, l);
