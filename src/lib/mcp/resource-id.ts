/**
 * Stable ids for the things `search` returns and `fetch` reads back.
 *
 * OpenAI's contract gives `fetch` one argument, an id, and nothing else. No
 * business, no caller context beyond the bearer. So the business has to travel
 * inside the id.
 *
 * **The id is an identifier, never an authorization.** Anyone can type one.
 * `fetch` parses the business out and then runs the caller's live role through
 * `requireMcpBusinessRole`, exactly as every other tool does, so a guessed or
 * copied id gets a caller no further than their own permissions already do.
 */

import { McpToolError } from "@/lib/mcp/auth";

export const MCP_RESOURCE_KINDS = ["contact", "thread", "call"] as const;

export type McpResourceKind = (typeof MCP_RESOURCE_KINDS)[number];

export type McpResourceId = {
  kind: McpResourceKind;
  businessId: string;
  /** E.164 for contact/thread, the call control id for call. */
  ref: string;
};

/** `contact:<businessId>:<e164>` and friends. */
export function formatMcpResourceId(id: McpResourceId): string {
  return `${id.kind}:${id.businessId}:${id.ref}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse an id, or refuse.
 *
 * The refusal is deliberately one generic message for every malformed shape.
 * A message that distinguished "no such business" from "not your business"
 * would answer questions about other tenants to anyone willing to iterate,
 * which is the same reason `requireMcpBusinessRole` has a single refusal.
 */
export function parseMcpResourceId(raw: string): McpResourceId {
  const refuse = (): never => {
    throw new McpToolError(
      "That id is not one this connector issued. Call search first and pass an id from its results."
    );
  };

  // Split into exactly three parts: the ref itself never contains a colon
  // (E.164 and Telnyx call control ids do not), so a longer split is malformed
  // rather than something to be lenient about.
  const parts = raw.split(":");
  if (parts.length !== 3) return refuse();
  const [kind, businessId, ref] = parts;

  if (!(MCP_RESOURCE_KINDS as readonly string[]).includes(kind)) return refuse();
  if (!UUID.test(businessId)) return refuse();
  if (!ref) return refuse();

  return { kind: kind as McpResourceKind, businessId, ref };
}
