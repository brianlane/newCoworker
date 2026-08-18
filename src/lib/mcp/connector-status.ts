/**
 * MCP connector (Claude / ChatGPT) connection status, per
 * (auth user, client, business) — `mcp_connector_status`.
 *
 * `recordMcpConnectorSeen` is called from the tool-call authorization path
 * (`mcpBusinessRoleOutcome`, src/lib/mcp/auth.ts) once a call is allowed. That
 * is the first moment all three parts of the key exist at once: the bearer
 * check resolves only (userId, email), and the business is chosen per tool
 * call. It is also the strongest available proof that the connector works:
 * the documented failure mode has OAuth succeed while the vendor's POSTs 403
 * at the WAF, so a consent-time stamp would show Connected for a connector
 * that never worked. An authorized tool call rules that out.
 *
 * The trade-off, which the card's copy states: an assistant that is added but
 * never asked to do anything sends only `initialize` / `tools/list`, so the
 * tile stays "Available" until the first real request.
 *
 * `last_seen_at` updates are debounced so tool-call bursts cost one read, not
 * a write per request.
 *
 * The dashboard integrations page reads by BUSINESS, not by login: the page is
 * business-scoped, and reading by login meant an admin using view-as saw their
 * own connector painted onto every tenant's tile (and a teammate's genuine
 * connection showed for nobody else).
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { McpClient } from "@/lib/mcp/routes";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Unconditional-await client resolution — an inline `client ?? (await …)`
 * followed by branches makes v8 coverage mis-attribute the continuation
 * block (negative implicit-else counts).
 */
async function resolveClient(client?: SupabaseClient): Promise<SupabaseClient> {
  return client ?? (await createSupabaseServiceClient());
}

export type McpConnectorStatus = {
  firstConnectedAt: string;
  lastSeenAt: string;
  /** The login whose assistant made the most recent call on this business. */
  userId: string;
};

/** How stale `last_seen_at` must be before a request refreshes it. */
export const MCP_SEEN_DEBOUNCE_MS = 5 * 60_000;

/**
 * How quiet a connector must go before the tile stops claiming Connected.
 *
 * Nothing tells us a connector was removed on the assistant's side: revoking
 * it in Claude or ChatGPT is invisible here, so without this the badge stayed
 * green forever. Thirty days is deliberately long — this is an "it has gone
 * quiet" signal, not a session timeout, and a tenant who uses their coworker
 * monthly should not be nagged.
 */
export const MCP_STALE_MS = 30 * 24 * 60 * 60_000;

/** Postgres unique-violation SQLSTATE (concurrent first-request race). */
const PG_UNIQUE_VIOLATION = "23505";

/** Has this connector gone quiet long enough to stop reading as connected? */
export function isMcpConnectorStale(lastSeenAt: string, nowMs: number = Date.now()): boolean {
  const lastSeenMs = Date.parse(lastSeenAt);
  // An unparseable timestamp is not evidence of staleness; treat it as fresh
  // rather than telling a working tenant to reconnect.
  if (!Number.isFinite(lastSeenMs)) return false;
  return nowMs - lastSeenMs >= MCP_STALE_MS;
}

/**
 * This business's most recent connector activity for one client, from ANY
 * login that can reach it; null = no assistant has ever acted on it.
 */
export async function getMcpConnectorStatusForBusiness(
  businessId: string,
  mcpClient: McpClient,
  client?: SupabaseClient
): Promise<McpConnectorStatus | null> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("mcp_connector_status")
    .select("user_id, first_connected_at, last_seen_at")
    .eq("business_id", businessId)
    .eq("client", mcpClient)
    // Bounded on purpose: a business with several connected teammates has one
    // row each, and the tile only ever shows the latest.
    .order("last_seen_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`getMcpConnectorStatusForBusiness: ${error.message}`);
  const rows = (data ?? []) as Array<{
    user_id: string;
    first_connected_at: string;
    last_seen_at: string;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    firstConnectedAt: row.first_connected_at,
    lastSeenAt: row.last_seen_at,
    userId: row.user_id
  };
}

/**
 * Is THIS login one of the ones whose assistant has acted on this business?
 *
 * The Disconnect button asks before it revokes anything. `auth.oauth` acts on
 * the signed-in user's own grants, so revoking unconditionally would let an
 * admin using view-as destroy their OWN Claude access while clearing someone
 * else's tile, and leave the tenant's connector untouched to re-light it.
 */
export async function hasMcpConnectorRow(
  userId: string,
  businessId: string,
  mcpClient: McpClient,
  client?: SupabaseClient
): Promise<boolean> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("mcp_connector_status")
    .select("user_id")
    .eq("user_id", userId)
    .eq("business_id", businessId)
    .eq("client", mcpClient)
    .maybeSingle();
  if (error) throw new Error(`hasMcpConnectorRow: ${error.message}`);
  return data !== null;
}

/**
 * Stamp "an authorized MCP call just touched this business" for this user.
 * Inserts the row on the first call; afterwards refreshes `last_seen_at` at
 * most once per debounce window. NEVER throws — status bookkeeping must not
 * fail a live tool call.
 */
export async function recordMcpConnectorSeen(
  userId: string,
  mcpClient: McpClient,
  businessId: string,
  client?: SupabaseClient,
  nowMs: number = Date.now()
): Promise<void> {
  try {
    const db = await resolveClient(client);
    const { data, error } = await db
      .from("mcp_connector_status")
      .select("last_seen_at")
      .eq("user_id", userId)
      .eq("client", mcpClient)
      .eq("business_id", businessId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as { last_seen_at: string } | null;

    if (!row) {
      const nowIso = new Date(nowMs).toISOString();
      const { error: insErr } = await db.from("mcp_connector_status").insert({
        user_id: userId,
        client: mcpClient,
        business_id: businessId,
        first_connected_at: nowIso,
        last_seen_at: nowIso
      });
      // A concurrent first request won the insert — same outcome, no retry.
      if (insErr && insErr.code !== PG_UNIQUE_VIOLATION) {
        throw new Error(insErr.message);
      }
      return;
    }

    const lastSeenMs = Date.parse(row.last_seen_at);
    if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs < MCP_SEEN_DEBOUNCE_MS) {
      return; // fresh enough, reads stay the common case
    }
    const { error: updErr } = await db
      .from("mcp_connector_status")
      .update({ last_seen_at: new Date(nowMs).toISOString() })
      .eq("user_id", userId)
      .eq("client", mcpClient)
      .eq("business_id", businessId);
    if (updErr) throw new Error(updErr.message);
  } catch (err) {
    logger.warn("mcp connector-status: seen stamp failed", {
      userId,
      client: mcpClient,
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Clear one client's status for a business (the Disconnect button), across
 * every login. Returns how many rows went, because a PostgREST delete that
 * matches nothing succeeds silently and the route must not report a clear it
 * did not make.
 */
export async function deleteMcpConnectorStatus(
  businessId: string,
  mcpClient: McpClient,
  client?: SupabaseClient
): Promise<number> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("mcp_connector_status")
    .delete()
    .eq("business_id", businessId)
    .eq("client", mcpClient)
    .select("user_id");
  if (error) throw new Error(`deleteMcpConnectorStatus: ${error.message}`);
  return ((data ?? []) as unknown[]).length;
}
