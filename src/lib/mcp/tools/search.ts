/**
 * `search` and `fetch`: the pair ChatGPT requires.
 *
 * A ChatGPT connector without both is rejected outright unless the user has
 * Developer Mode on, so these are not optional garnish. They are also the
 * shape a model actually wants: one call to find the right customer,
 * conversation or call, then one call to read it, instead of guessing which
 * of thirty tools to try.
 *
 * `search` covers contacts, and yields each match's text conversation
 * alongside the profile, so "find Maria" then "read our texts" works in two
 * calls. `fetch` additionally reads calls, whose ids come from
 * `list_call_transcripts`.
 *
 * Two things are deliberately NOT searched in v1, both for reasons that would
 * not improve by trying harder now:
 *
 * - **Message bodies.** There is no full-text index on `sms_history`, so an
 *   `ilike '%q%'` over it is a sequential scan per business per query on what
 *   would be our hottest search. That wants a `pg_trgm` index and a recency
 *   bound, which is its own change.
 * - **Call summaries.** Voice transcripts have a residency read path (rows can
 *   live on a tenant's own VPS, see `isVpsReadMode`), so a search helper has
 *   to satisfy both paths or silently miss exactly the tenants who paid for
 *   data residency. Worth doing properly rather than as a footnote here.
 */

import { z } from "zod";
import {
  mcpBusinessRoleAllows,
  McpToolError,
  requireMcpBusinessRole,
  resolveMcpBusinessIdsForSearch,
  type McpAuthUser
} from "@/lib/mcp/auth";
import { defineMcpTool, TOOL_BEHAVIOR } from "@/lib/mcp/tooling";
import {
  formatMcpResourceId,
  parseMcpResourceId,
  type McpResourceId
} from "@/lib/mcp/resource-id";
import { mcpDashboardUrl } from "@/lib/mcp/urls";

/** Per business, so a five-business fan-out stays a readable answer. */
const CONTACTS_PER_BUSINESS = 5;
/** Rendered records are for reading, not bulk export. */
const MAX_FETCH_CHARS = 20_000;
const THREAD_MESSAGE_LIMIT = 100;

const RESULT_SHAPE = z.looseObject({
  id: z.string(),
  title: z.string(),
  url: z.string()
});

/** One business's slice of a search, or nothing when the caller cannot read it. */
async function searchOneBusiness(
  auth: McpAuthUser,
  businessId: string,
  query: string,
  labelBusiness: boolean,
  listCustomerMemories: (
    businessId: string,
    options: { search?: string; limit?: number }
  ) => Promise<Array<{ customer_e164: string; display_name: string | null }>>
): Promise<Array<{ id: string; title: string; url: string }>> {
  // Silently skipped rather than refused: on a multi-business account,
  // reaching one you cannot read is the normal case, and a search that
  // errored on it would be useless.
  if (!(await mcpBusinessRoleAllows(auth, businessId, "operate_messages"))) return [];

  const results: Array<{ id: string; title: string; url: string }> = [];
  const suffix = labelBusiness ? await businessLabel(businessId) : "";

  const contacts = await listCustomerMemories(businessId, {
    search: query,
    limit: CONTACTS_PER_BUSINESS
  });
  for (const row of contacts) {
    const who = row.display_name?.trim() || row.customer_e164;
    for (const kind of ["contact", "thread"] as const) {
      const id: McpResourceId = { kind, businessId, ref: row.customer_e164 };
      results.push({
        id: formatMcpResourceId(id),
        title:
          kind === "contact"
            ? `${who}${suffix}`
            : `Text conversation with ${who}${suffix}`,
        url: mcpDashboardUrl(id)
      });
    }
  }

  return results;
}

/** " (Business Name)" for a fan-out, so two Marias are tellable apart. */
async function businessLabel(businessId: string): Promise<string> {
  const { getBusiness } = await import("@/lib/db/businesses");
  const business = await getBusiness(businessId);
  return business?.name ? ` (${business.name})` : "";
}

export const searchTool = defineMcpTool({
  name: "search",
  title: "Search customers",
  annotations: TOOL_BEHAVIOR.readLocal,
  description:
    "Find a customer and their text conversation by name or phone number. Returns ids to pass to fetch for the full record. Searches every business this account can access unless business_id is given.",
  schema: {
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("A customer's name or phone number, or part of one."),
    business_id: z
      .string()
      .uuid()
      .optional()
      .describe("Limit the search to one business. Omit to search all of them.")
  },
  outputSchema: z.object({ results: z.array(RESULT_SHAPE) }),
  handler: async (args, auth) => {
    const businessIds = await resolveMcpBusinessIdsForSearch(auth, args.business_id);
    const label = businessIds.length > 1;
    // Resolved ONCE, before the fan-out. Doing the dynamic import inside each
    // concurrent branch resolves the same module N times for no benefit, and
    // it is the shape that made these tests reach the real database helper
    // instead of the mocked one.
    const { listCustomerMemories } = await import("@/lib/customer-memory/db");
    // Sequential, not Promise.all. Two reasons, and the second is the one
    // that would have been easy to miss:
    //
    // 1. Bounded load. Each business costs a role check plus a contact query,
    //    so a five-business fan-out is up to fifteen statements. Serialising
    //    keeps a chatty client from multiplying concurrent connections, and
    //    the common case is one business, where this is identical anyway.
    // 2. Concurrent `await import()` of the same module does not reliably
    //    resolve to a mocked module under vitest, which made the
    //    multi-business tests silently reach the real database helper. The
    //    tests are what surfaced it; the load argument is why it stays.
    const perBusiness: Array<Array<{ id: string; title: string; url: string }>> = [];
    for (const id of businessIds) {
      perBusiness.push(
        await searchOneBusiness(auth, id, args.query, label, listCustomerMemories)
      );
    }
    return { results: perBusiness.flat() };
  }
});

/** Cap the rendered text without pretending the record was shorter. */
function clamp(text: string): string {
  return text.length <= MAX_FETCH_CHARS
    ? text
    : `${text.slice(0, MAX_FETCH_CHARS)}\n\n[truncated]`;
}

async function fetchContact(businessId: string, e164: string): Promise<string> {
  const { getCustomerMemory } = await import("@/lib/customer-memory/db");
  const row = await getCustomerMemory(businessId, e164);
  if (!row) throw new McpToolError("That contact no longer exists.");
  return clamp(
    [
      `Name: ${row.display_name ?? "(unknown)"}`,
      `Phone: ${row.customer_e164}`,
      `Email: ${row.email ?? "(none)"}`,
      `Tags: ${(row.tags ?? []).join(", ") || "(none)"}`,
      `Last contact: ${row.last_interaction_at ?? "(never)"}`,
      "",
      "Pinned notes:",
      row.pinned_md?.trim() || "(none)",
      "",
      "What the AI remembers:",
      row.summary_md?.trim() || "(nothing yet)"
    ].join("\n")
  );
}

async function fetchThread(businessId: string, e164: string): Promise<string> {
  const { listMessagesForCustomer } = await import("@/lib/db/sms-history");
  const messages = await listMessagesForCustomer(businessId, e164, {
    limit: THREAD_MESSAGE_LIMIT
  });
  if (messages.length === 0) return "(no messages in this conversation yet)";
  return clamp(messages.map((m) => `${m.direction}: ${m.content ?? ""}`).join("\n"));
}

async function fetchCall(businessId: string, callId: string): Promise<string> {
  const { getTranscriptById, listTurns } = await import("@/lib/db/voice-transcripts");
  const transcript = await getTranscriptById(businessId, callId);
  if (!transcript) throw new McpToolError("That call no longer exists.");
  // businessId is required for residency routing: turns carry no business_id
  // of their own, so without it the read stays central and a residency
  // tenant's transcript comes back empty.
  const turns = await listTurns(callId, { businessId });
  return clamp(
    [
      `Caller: ${transcript.caller_e164 ?? "(unknown)"}`,
      `Started: ${transcript.started_at ?? "(unknown)"}`,
      `Status: ${transcript.status ?? "(unknown)"}`,
      "",
      "Summary:",
      transcript.summary?.trim() || "(none)",
      "",
      "Transcript:",
      turns.length > 0
        ? turns.map((t) => `${t.role}: ${t.content}`).join("\n")
        : "(no transcript captured)"
    ].join("\n")
  );
}

export const fetchTool = defineMcpTool({
  name: "fetch",
  title: "Open a search result",
  annotations: TOOL_BEHAVIOR.readLocal,
  description:
    "Read the full record behind an id returned by search: a customer's profile and notes, a whole text conversation, or a call's summary and transcript.",
  schema: {
    id: z.string().min(1).max(200).describe("An id from a search result.")
  },
  outputSchema: z.looseObject({
    id: z.string(),
    title: z.string(),
    text: z.string(),
    url: z.string()
  }),
  handler: async (args, auth) => {
    const id = parseMcpResourceId(args.id);
    // The id said which business; the CALLER's live role decides whether they
    // may read it. An id is never a capability.
    await requireMcpBusinessRole(auth, id.businessId, "operate_messages");

    const text =
      id.kind === "contact"
        ? await fetchContact(id.businessId, id.ref)
        : id.kind === "thread"
          ? await fetchThread(id.businessId, id.ref)
          : await fetchCall(id.businessId, id.ref);

    const title =
      id.kind === "contact"
        ? `Contact ${id.ref}`
        : id.kind === "thread"
          ? `Text conversation with ${id.ref}`
          : `Call ${id.ref}`;

    return { id: args.id, title, text, url: mcpDashboardUrl(id) };
  }
});

export const searchTools = [searchTool, fetchTool];
