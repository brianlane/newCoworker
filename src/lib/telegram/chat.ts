/**
 * The Telegram coworker surface: the prompt blocks and the fixed strings
 * the bot sends into a tenant's chat.
 *
 * Two prompt branches, matching every other owner surface: the verified
 * OWNER gets the dashboard persona, and anybody else the platform can
 * positively identify as staff gets the team persona with owner-power tools
 * hard off. Anyone the platform cannot identify gets silence, because on
 * this channel an unidentified account is a stranger who found the bot.
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
 * Telegram accepts 4096 characters. This is a phone chat, not a document,
 * so the ceiling is set well below what the API allows for the same reason
 * WhatsApp's is: a reply nobody scrolls to the end of was not delivered.
 */
export const TELEGRAM_REPLY_MAX_CHARS = 2000;

export const TELEGRAM_SURFACE_BLOCK = `THIS CONVERSATION IS ON TELEGRAM, with someone from the business. The platform has already confirmed who they are (they either shared the phone number Telegram verified, or redeemed a one-time code from the dashboard), so never ask them to prove who they are, never run the lead-intake script here, and never ask them for their contact details.
- Keep replies SHORT and plain-text: no markdown headings or tables, no bullet lists unless you are listing options, well under ${TELEGRAM_REPLY_MAX_CHARS} characters.
- You HAVE working tools on this surface. Use them per your rules; never claim you cannot act just because this is Telegram.
- When you need a decision, ask ONE clear question and wait for their reply.`;

export const TELEGRAM_TEAM_PREAMBLE = `You are the business's AI coworker, messaging on Telegram with a TEAM MEMBER (the platform matched their account to the business's roster; do not ask them to prove who they are, and do not treat them as a customer).
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
 * Shown to an account the platform cannot place.
 *
 * Deliberately says nothing about the business: whoever this is found a bot
 * they were not given, and confirming which business it belongs to would
 * tell them something they did not know. It also does not say "you are not
 * authorised", which invites guessing; it says how a real teammate would
 * get set up, which is useless to anyone else.
 */
const NEEDS_LINKING: Record<AppLocale, string> = {
  en: "Before I can help, someone from the business needs to connect this Telegram account. Ask them to open Settings, then Integrations, then Telegram, and send you a connect code. Then send me that code here.",
  es: "Antes de poder ayudarte, alguien del negocio tiene que conectar esta cuenta de Telegram. Pídele que abra Configuración, luego Integraciones y luego Telegram, y que te envíe un código. Después mándame ese código por aquí."
};

const LINK_ACCEPTED: Record<AppLocale, string> = {
  en: "✅ You're connected. Ask me anything about the business.",
  es: "✅ Ya estás conectado. Pregúntame lo que quieras sobre el negocio."
};

const LINK_REJECTED: Record<AppLocale, string> = {
  en: "That code is not valid any more. Codes expire after 15 minutes and work only once, so ask for a fresh one.",
  es: "Ese código ya no es válido. Los códigos caducan a los 15 minutos y solo funcionan una vez, así que pide uno nuevo."
};

const SHARE_CONTACT_BUTTON: Record<AppLocale, string> = {
  en: "Share my phone number",
  es: "Compartir mi número"
};

const CONTACT_NOT_YOURS: Record<AppLocale, string> = {
  en: "That contact card belongs to somebody else. Please share your OWN number using the button, or send a connect code from the dashboard.",
  es: "Esa tarjeta de contacto es de otra persona. Comparte tu PROPIO número con el botón, o envía un código de conexión del panel."
};

const OVER_CAP: Record<AppLocale, string> = {
  en: "I've hit this month's AI usage limit for the business, so I can't answer right now. The owner can raise it from the dashboard.",
  es: "He alcanzado el límite de uso de IA del negocio este mes, así que no puedo responder ahora. El propietario puede ampliarlo desde el panel."
};

const TIER_BLOCKED: Record<AppLocale, string> = {
  en: "The Telegram integration is available on Standard and Enterprise plans.",
  es: "La integración de Telegram está disponible en los planes Standard y Enterprise."
};

const TURN_FAILED: Record<AppLocale, string> = {
  en: "Something went wrong on my end and I couldn't finish that. Please try again.",
  es: "Algo ha fallado por mi parte y no he podido terminar. Inténtalo de nuevo."
};

const pick = (table: Record<AppLocale, string>, locale: AppLocale = "en"): string =>
  table[locale] ?? table.en;

export const telegramOnboardingMessage = (l?: AppLocale) => pick(ONBOARDING, l);
export const telegramNeedsLinkingMessage = (l?: AppLocale) => pick(NEEDS_LINKING, l);
export const telegramLinkAcceptedMessage = (l?: AppLocale) => pick(LINK_ACCEPTED, l);
export const telegramLinkRejectedMessage = (l?: AppLocale) => pick(LINK_REJECTED, l);
export const telegramShareContactButton = (l?: AppLocale) => pick(SHARE_CONTACT_BUTTON, l);
export const telegramContactNotYoursMessage = (l?: AppLocale) => pick(CONTACT_NOT_YOURS, l);
export const telegramOverCapMessage = (l?: AppLocale) => pick(OVER_CAP, l);
export const telegramTierBlockedMessage = (l?: AppLocale) => pick(TIER_BLOCKED, l);
export const telegramTurnFailedMessage = (l?: AppLocale) => pick(TURN_FAILED, l);
