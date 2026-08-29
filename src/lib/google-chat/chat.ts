/**
 * The Google Chat coworker surface: prompt blocks and the fixed strings the
 * app posts into a tenant's Chat space.
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
 * Chat renders long messages fine, but this is a chat thread rather than a
 * document. Sized with Slack's ceiling for the same reason: a reply nobody
 * scrolls to the end of was not delivered.
 */
export const GOOGLE_CHAT_REPLY_MAX_CHARS = 3900;

export const GOOGLE_CHAT_SURFACE_BLOCK = `THIS CONVERSATION IS IN GOOGLE CHAT, inside the business's own Google Workspace. You are talking with a member of the team, not a customer. Their identity comes from their Workspace account, so never ask them to prove who they are, never run the lead-intake script here, and never ask them for their contact details.
- Format for Google Chat: short paragraphs, *bold* with single asterisks, bullet lines with "-". No markdown headings and no tables.
- Keep replies under ${GOOGLE_CHAT_REPLY_MAX_CHARS} characters.
- You HAVE working tools on this surface. Use them per your rules; never claim you cannot act just because this is Google Chat.
- When you need a decision, ask ONE clear question and wait for the reply.`;

export const GOOGLE_CHAT_TEAM_PREAMBLE = `You are the business's AI coworker, talking in Google Chat with a TEAM MEMBER (their identity comes from their Google Workspace account; do not ask them to prove who they are, and do not treat them as a customer).
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
 * Shown in a space that is not bound to any business.
 *
 * Deliberately says nothing about any business, because at this point we do
 * not know of one: our Chat app can be added to any space in any Workspace
 * that can find it, and this message is the reply to a complete stranger.
 * The connect code is what binds the space, so asking for it IS the whole
 * of setup.
 */
const UNBOUND_SPACE: Record<AppLocale, string> = {
  en: "To connect this space to your business, open your New Coworker dashboard, go to Settings, then Integrations, then Google Chat, and generate a connect code. Send that code here and I'll finish setting up.",
  es: "Para conectar este espacio con tu negocio, abre tu panel de New Coworker, ve a Configuración, luego Integraciones y luego Google Chat, y genera un código de conexión. Envía ese código aquí y terminaré la configuración."
};

/**
 * Shown to somebody in a CONNECTED space that the roster does not place.
 * Different from the unbound message: here the business is known, so the
 * fix is a code for this person rather than for the space.
 */
const NEEDS_LINKING: Record<AppLocale, string> = {
  en: "Before I can help, someone from the business needs to connect your Google Chat account. Ask them to open Settings, then Integrations, then Google Chat, and send you a connect code.",
  es: "Antes de poder ayudarte, alguien del negocio tiene que conectar tu cuenta de Google Chat. Pídele que abra Configuración, luego Integraciones y luego Google Chat, y te envíe un código de conexión."
};

/**
 * Shown when a code is spent in a SECOND space while a first is already
 * bound. Alerts go to the bound space, so moving it from inside a chat
 * message would send them somewhere the owner never chose.
 */
const ALREADY_BOUND: Record<AppLocale, string> = {
  en: "This business is already connected to a different Google Chat space, so I've left it where it is. That code is now used up. To move alerts here, disconnect Google Chat in Settings, then Integrations, and set it up again from this space.",
  es: "Este negocio ya está conectado a otro espacio de Google Chat, así que lo he dejado donde estaba. Ese código ya está gastado. Para mover los avisos aquí, desconecta Google Chat en Configuración, luego Integraciones, y vuelve a configurarlo desde este espacio."
};

/**
 * Shown when the code was accepted but the space could not be saved.
 *
 * Says the code is used up, because it is: a code is single use and which
 * business it belongs to is only knowable by redeeming it, so there is no
 * ordering that could have checked first. Being told to fetch a new one is
 * mildly annoying; being told the code was invalid, which is what a silent
 * retry produces, is untrue and a dead end.
 */
const BIND_FAILED: Record<AppLocale, string> = {
  en: "I couldn't finish connecting this space, and that code is now used up. Generate a new connect code in Settings, then Integrations, then Google Chat, and send it here again.",
  es: "No he podido terminar de conectar este espacio, y ese código ya está gastado. Genera un código de conexión nuevo en Configuración, luego Integraciones y luego Google Chat, y envíalo aquí otra vez."
};

const LINK_REJECTED: Record<AppLocale, string> = {
  en: "That connect code isn't valid any more. Codes work once and expire after 15 minutes, so ask for a fresh one.",
  es: "Ese código de conexión ya no es válido. Los códigos funcionan una sola vez y caducan a los 15 minutos, así que pide uno nuevo."
};

const OVER_CAP: Record<AppLocale, string> = {
  en: "I've hit this month's AI usage limit for the business, so I can't answer right now. The owner can raise it from the dashboard.",
  es: "He alcanzado el límite de uso de IA del negocio este mes, así que no puedo responder ahora. El propietario puede ampliarlo desde el panel."
};

const TIER_BLOCKED: Record<AppLocale, string> = {
  en: "The Google Chat integration is available on Standard and Enterprise plans.",
  es: "La integración de Google Chat está disponible en los planes Standard y Enterprise."
};

const TURN_FAILED: Record<AppLocale, string> = {
  en: "Something went wrong on my end and I couldn't finish that. Please try again.",
  es: "Algo ha fallado por mi parte y no he podido terminar. Inténtalo de nuevo."
};

const pick = (table: Record<AppLocale, string>, locale: AppLocale = "en"): string =>
  table[locale] ?? table.en;

export const googleChatOnboardingMessage = (l?: AppLocale) => pick(ONBOARDING, l);
export const googleChatUnboundSpaceMessage = (l?: AppLocale) => pick(UNBOUND_SPACE, l);
export const googleChatNeedsLinkingMessage = (l?: AppLocale) => pick(NEEDS_LINKING, l);
export const googleChatAlreadyBoundMessage = (l?: AppLocale) => pick(ALREADY_BOUND, l);
export const googleChatBindFailedMessage = (l?: AppLocale) => pick(BIND_FAILED, l);
export const googleChatLinkRejectedMessage = (l?: AppLocale) => pick(LINK_REJECTED, l);
export const googleChatOverCapMessage = (l?: AppLocale) => pick(OVER_CAP, l);
export const googleChatTierBlockedMessage = (l?: AppLocale) => pick(TIER_BLOCKED, l);
export const googleChatTurnFailedMessage = (l?: AppLocale) => pick(TURN_FAILED, l);
