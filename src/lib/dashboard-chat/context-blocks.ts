/**
 * Shared per-turn context blocks for the OWNER-OPERATOR chat surfaces —
 * dashboard chat (/api/dashboard/chat) and the owner-over-SMS turn
 * (/api/internal/owner-sms-turn). Extracted from the dashboard chat route
 * so both surfaces ground the model identically:
 *
 *  - `buildIntegrationsStatusLine`: what is ACTUALLY connected (calendar
 *    provider + mailbox), so "are you connected to Calendly?" is answered
 *    from fact — the KYP Ads conversation (Jul 15) had the assistant deny,
 *    then claim, Calendly access within four turns while a live connection
 *    existed the whole time.
 *  - `buildBusinessContextBlock`: the business identity/memory the worker
 *    path carries inside the Rowboat agent's seeded instructions (vault
 *    sync); the platform-side engines would otherwise answer configuration
 *    questions blind.
 *
 * Both are best-effort: a read failure degrades to null (no block), never a
 * failed turn.
 */

import { getBusinessConfig } from "@/lib/db/configs";
import {
  resolveCalendarConnection,
  resolveEmailConnection
} from "@/lib/voice-tools/connections";
import { logger } from "@/lib/logger";

/**
 * Human labels for the calendar providers resolveCalendarConnection can
 * return. Calendly gets its link-mode caveat inline so the model never
 * promises direct booking on a link-only provider.
 */
const CALENDAR_PROVIDER_LABELS: Record<string, string> = {
  vagaro: "Vagaro (real availability search + direct booking)",
  google: "Google Calendar",
  microsoft: "Outlook Calendar",
  caldav: "CalDAV (e.g. iCloud)",
  calendly:
    "Calendly (slot search + scheduling links, booking hands the person a single-use link, it cannot book on their behalf)"
};

export type ContextBlockDeps = {
  /** Injectable resolvers/reads (tests). */
  resolveCalendar?: typeof resolveCalendarConnection;
  resolveEmail?: typeof resolveEmailConnection;
  fetchConfig?: typeof getBusinessConfig;
};

/** Per-turn "what is actually connected" system line. Null on failure. */
export async function buildIntegrationsStatusLine(
  businessId: string,
  deps: ContextBlockDeps = {}
): Promise<string | null> {
  /* c8 ignore next 2 -- production defaults; tests inject */
  const resolveCalendar = deps.resolveCalendar ?? resolveCalendarConnection;
  const resolveEmail = deps.resolveEmail ?? resolveEmailConnection;
  try {
    const [calendar, email] = await Promise.all([
      resolveCalendar(businessId),
      resolveEmail(businessId)
    ]);
    const calendarLabel = calendar
      ? CALENDAR_PROVIDER_LABELS[calendar.provider] ?? calendar.provider
      : "not connected";
    const emailLabel = email
      ? email.provider === "google"
        ? "Google mailbox connected"
        : "Microsoft mailbox connected"
      : "not connected";
    return (
      "CONNECTED INTEGRATIONS (ground truth for THIS turn, answer connection questions from this line, never guess or ask the owner for API details):\n" +
      `- Calendar: ${calendarLabel}\n` +
      `- Email mailbox: ${emailLabel}\n` +
      "- Texting: the business's own SMS number (always available on this platform)."
    );
  } catch (err) {
    logger.warn("owner chat: integrations status line failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Per-side cap on the identity/memory blocks. Generous (Gemini flash
 * context is huge) but bounded so a pathological memory_md can't dominate
 * the prompt. Memory keeps its TAIL (owner-chat capture sections append
 * newest-last).
 */
export const BUSINESS_CONTEXT_MAX_CHARS = 12_000;

/** Business identity + memory system block. Null when empty or on failure. */
export async function buildBusinessContextBlock(
  businessId: string,
  deps: ContextBlockDeps = {}
): Promise<string | null> {
  /* c8 ignore next -- production default; tests inject */
  const fetchConfig = deps.fetchConfig ?? getBusinessConfig;
  try {
    const config = await fetchConfig(businessId);
    if (!config) return null;
    const clipHead = (s: string): string =>
      s.length > BUSINESS_CONTEXT_MAX_CHARS
        ? `${s.slice(0, BUSINESS_CONTEXT_MAX_CHARS)}\n… (truncated)`
        : s;
    const clipTail = (s: string): string =>
      s.length > BUSINESS_CONTEXT_MAX_CHARS
        ? `… (older content truncated)\n${s.slice(-BUSINESS_CONTEXT_MAX_CHARS)}`
        : s;
    const identity = (config.identity_md ?? "").trim();
    const memory = (config.memory_md ?? "").trim();
    if (!identity && !memory) return null;
    const parts = [
      "YOUR BUSINESS CONFIGURATION (identity + memory, the owner's own data; quote from it freely):"
    ];
    if (identity) parts.push(`# identity.md\n${clipHead(identity)}`);
    if (memory) parts.push(`# memory.md\n${clipTail(memory)}`);
    return parts.join("\n\n");
  } catch (err) {
    logger.warn("owner chat: business context block read failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
