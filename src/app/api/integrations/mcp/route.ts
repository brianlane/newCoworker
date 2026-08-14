/**
 * Owner-facing Disconnect for a business's AI-assistant connector
 * (Claude or ChatGPT), behind the card at
 * /dashboard/integrations/{claude,chatgpt}.
 *
 *   DELETE {businessId, client}  → best-effort revoke of the CALLER's OAuth
 *                                  grant at Supabase Auth, then clear the
 *                                  business's status rows for that assistant.
 *
 * There is no connect counterpart: connecting happens inside Claude or
 * ChatGPT, and the tile lights when the assistant makes its first authorized
 * call (see src/lib/mcp/connector-status.ts).
 *
 * The two halves are deliberately unequal. Clearing the status row is ours and
 * always lands; revoking the grant only works for the caller's own login, so a
 * teammate's grant and (under admin view-as) the tenant's grant survive. The
 * response reports which happened so the card can say so rather than implying
 * the assistant lost access.
 *
 * That asymmetry is also why the revoke is CONDITIONAL. Revoking whatever the
 * signed-in session holds would mean an admin using view-as loses their own
 * Claude access to clear a tenant's card, while the tenant's connector lives
 * on. So the route first checks that the caller's own login is one of the ones
 * connected to this business, and skips the revoke otherwise.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { deleteMcpConnectorStatus, hasMcpConnectorRow } from "@/lib/mcp/connector-status";
import { revokeMcpGrantsForClient } from "@/lib/mcp/grants";
import { MCP_CLIENTS } from "@/lib/mcp/routes";

const deleteSchema = z.object({
  businessId: z.string().uuid(),
  client: z.enum(MCP_CLIENTS)
});

async function authorize(businessId: string) {
  const user = await getAuthUser();
  if (!user?.email) return null;
  if (!user.isAdmin) {
    await requireBusinessRole(businessId, "manage_settings");
  }
  return user;
}

export async function DELETE(request: Request) {
  try {
    const body = deleteSchema.parse(await request.json());
    const user = await authorize(body.businessId);
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    // Revoke ONLY when the caller's own login is one of the ones connected to
    // this business. `auth.oauth` acts on the signed-in user's grants, so an
    // unconditional revoke would let an admin using view-as destroy their own
    // Claude access while clearing a tenant's tile, and leave the tenant's
    // connector alive to re-light it on its next call. Same for a teammate
    // clearing a card that is not theirs.
    const callerIsConnectedHere = await hasMcpConnectorRow(
      user.userId,
      body.businessId,
      body.client
    );
    // Session-scoped client on purpose: the service client holds no grants.
    const revoke = callerIsConnectedHere
      ? await revokeMcpGrantsForClient(await createSupabaseServerClient(), body.client)
      : { revoked: 0, skippedReason: "caller_not_connected_here" as const };

    const cleared = await deleteMcpConnectorStatus(body.businessId, body.client);
    return successResponse({
      cleared,
      revoked: revoke.revoked,
      revokeSkippedReason: revoke.skippedReason
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
