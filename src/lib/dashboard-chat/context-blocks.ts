/**
 * Shared per-turn context blocks for the OWNER-OPERATOR chat surfaces,
 * dashboard chat (/api/dashboard/chat) and the owner-over-SMS turn
 * (/api/internal/owner-sms-turn). Extracted from the dashboard chat route
 * so both surfaces ground the model identically:
 *
 *  - `buildIntegrationsStatusLine`: what is ACTUALLY connected (calendar
 *    provider + mailbox), so "are you connected to Calendly?" is answered
 *    from fact, the KYP Ads conversation (Jul 15) had the assistant deny,
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

import { buildCustomTablesDigestMd } from "@/lib/custom-tables/core";
import { countRowsByTable, listCustomTables } from "@/lib/custom-tables/db";
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
  acuity: "Acuity Scheduling (real availability search + direct booking)",
  google: "Google Calendar",
  microsoft: "Outlook Calendar",
  caldav: "CalDAV (e.g. iCloud)",
  calendly:
    "Calendly (slot search + scheduling links, booking hands the person a single-use link, it cannot book on their behalf)"
};

export type ContextBlockDeps = {
  /** Injectable for tests; production reads the owner's own tables. */
  fetchTables?: typeof listCustomTables;
  countRows?: typeof countRowsByTable;
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

/**
 * Business identity + memory, plus a one-line-per-table digest of the
 * owner's own Tables. Null when everything is empty or the read failed.
 *
 * The tables digest lives HERE and deliberately nowhere else. It is names
 * and column labels only, never row contents: the coworker reads rows live
 * through the custom_table_ tools, so a prompt copy would be both enormous
 * and stale. Without it the coworker cannot volunteer "you have an Equipment
 * table" until it has spent a tool call finding out.
 *
 * Why not in buildAgentInstructions (the vault sync): that string is written
 * to EVERY agent in Mongo, including the customer-facing texting coworker,
 * so folding the digest in there would print the owner's table names and
 * column labels into the prompt of the agent that answers customers. The
 * same reasoning rules out the messenger and webchat engines. This function
 * is the inline OWNER path, which is exactly the audience the tools are
 * gated to: dashboard chat, owner-over-SMS, email, and Slack.
 */
export async function buildBusinessContextBlock(
  businessId: string,
  deps: ContextBlockDeps = {}
): Promise<string | null> {
  /* c8 ignore next 2 -- production defaults; tests inject */
  const fetchConfig = deps.fetchConfig ?? getBusinessConfig;
  const fetchTables = deps.fetchTables ?? listCustomTables;
  const countRows = deps.countRows ?? countRowsByTable;
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
    // Best-effort: a tables read that fails must not cost the owner their
    // identity and memory context, which is the load-bearing half.
    let tablesMd = "";
    try {
      const tables = await fetchTables(businessId);
      if (tables.length > 0) {
        const counts = await countRows(businessId);
        tablesMd = buildCustomTablesDigestMd(
          tables.map((t) => ({
            name: t.name,
            rowLink: t.rowLink,
            fields: t.fields,
            rowCount: counts.get(t.id) ?? 0
          }))
        );
      }
    } catch (err) {
      logger.warn("owner chat: custom tables digest read failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    if (!identity && !memory && !tablesMd) return null;
    const parts = [
      "YOUR BUSINESS CONFIGURATION (identity + memory, the owner's own data; quote from it freely):"
    ];
    if (identity) parts.push(`# identity.md\n${clipHead(identity)}`);
    if (memory) parts.push(`# memory.md\n${clipTail(memory)}`);
    if (tablesMd) parts.push(tablesMd);
    return parts.join("\n\n");
  } catch (err) {
    logger.warn("owner chat: business context block read failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
