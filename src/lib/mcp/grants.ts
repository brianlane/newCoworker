/**
 * Revoking a connector's OAuth grant, for the Disconnect button on the
 * connector card.
 *
 * Supabase is the authorization server, so the grant is not ours to delete
 * directly: supabase-js exposes `auth.oauth.listGrants()` and
 * `auth.oauth.revokeGrant({ clientId })` on a SESSION-scoped client, acting on
 * the signed-in user's own grants. Revoking marks the consent revoked, drops
 * that client's sessions, and invalidates its refresh tokens.
 *
 * Two limits follow from "the grant belongs to the login", and the card's copy
 * says both out loud:
 *
 *  - one teammate cannot revoke another teammate's grant, and
 *  - an admin using view-as revokes nothing of the tenant's.
 *
 * In those cases Disconnect still clears the status row, and the assistant
 * re-stamps the tile on its next authorized call. That is why the route treats
 * revocation as best-effort and the row deletion as the part that must land.
 *
 * Which grant belongs to which assistant is matched on the registered client
 * name and URI, because Claude and ChatGPT self-register through DCR and we
 * never see the registration. The match is deliberately narrow: an unmatched
 * grant is left alone rather than revoked on a guess, since revoking the wrong
 * one would silently break a different integration the user still wants.
 */

import type { McpClient } from "@/lib/mcp/routes";

/** One registered OAuth client, as `listGrants()` reports it. */
export type OAuthGrantClient = {
  id: string;
  name?: string | null;
  uri?: string | null;
};

/**
 * Name/URI signatures per assistant. Anthropic's connector registers under a
 * Claude name and a claude.ai / anthropic.com URI; OpenAI's under a ChatGPT or
 * OpenAI name and a chatgpt.com / openai.com URI.
 */
const GRANT_SIGNATURES: Record<McpClient, RegExp> = {
  claude: /(^|[^a-z])claude([^a-z]|$)|anthropic\.com|claude\.ai/i,
  chatgpt: /(^|[^a-z])chat\s*gpt([^a-z]|$)|openai\.com|chatgpt\.com/i
};

/** Does this registered client look like the given assistant? */
export function grantMatchesClient(client: OAuthGrantClient, mcpClient: McpClient): boolean {
  const haystack = `${client.name ?? ""} ${client.uri ?? ""}`.trim();
  if (!haystack) return false;
  return GRANT_SIGNATURES[mcpClient].test(haystack);
}

/** What a session client must look like for the revoke to be attempted. */
type GrantsCapableClient = {
  auth: {
    oauth: {
      listGrants: () => Promise<{
        data: Array<{ client: OAuthGrantClient }> | null;
        error: { message: string } | null;
      }>;
      revokeGrant: (options: { clientId: string }) => Promise<{
        error: { message: string } | null;
      }>;
    };
  };
};

export type McpGrantRevokeResult = {
  /** How many of the caller's grants for this assistant were revoked. */
  revoked: number;
  /**
   * Why nothing was revoked, when nothing was: no grant of the caller's
   * matched, or the Auth call failed. Null when at least one was revoked.
   * The route reports it so the UI can say what Disconnect did and did not do.
   */
  skippedReason: "no_matching_grant" | "revoke_failed" | null;
};

/**
 * Best-effort revoke of the SIGNED-IN user's grants for one assistant. Never
 * throws: the caller's real job is clearing the status row, and a Disconnect
 * that failed halfway through Auth must still do that.
 */
export async function revokeMcpGrantsForClient(
  supabase: GrantsCapableClient,
  mcpClient: McpClient
): Promise<McpGrantRevokeResult> {
  try {
    const { data, error } = await supabase.auth.oauth.listGrants();
    if (error) return { revoked: 0, skippedReason: "revoke_failed" };
    const matches = (data ?? []).filter((g) => grantMatchesClient(g.client, mcpClient));
    if (matches.length === 0) return { revoked: 0, skippedReason: "no_matching_grant" };

    let revoked = 0;
    for (const grant of matches) {
      const { error: revokeErr } = await supabase.auth.oauth.revokeGrant({
        clientId: grant.client.id
      });
      if (!revokeErr) revoked += 1;
    }
    if (revoked === 0) return { revoked: 0, skippedReason: "revoke_failed" };
    // A partial failure still counts as revoked: the tenant sees what landed,
    // and running Disconnect again retries whatever did not.
    return { revoked, skippedReason: null };
  } catch {
    return { revoked: 0, skippedReason: "revoke_failed" };
  }
}
