/**
 * Operator view of an impersonated tenant's passkeys.
 *
 *   GET    ?  -> the tenant's registered passkeys
 *   DELETE {passkeyId} -> revoke one of them
 *
 * The support cases: "which of my devices can still get in?", and "I lost the
 * laptop, take its key off my account".
 *
 * There is no POST, and that is not an omission. A passkey is a WebAuthn
 * credential minted by the tenant's own authenticator after a user-verification
 * gesture on their device; the private half never leaves it. Supabase's admin
 * API reflects that reality by exposing only `listPasskeys` and
 * `deletePasskey`, with no create. So "enroll a passkey for a tenant" is not a
 * permission we are missing, it is a thing that cannot exist for anyone. The
 * operator's path to getting a tenant enrolled is to get them signed in (see
 * /api/account/password-reset) and let them add it from their own device.
 *
 * View-as ONLY. The signed-in user's own passkeys are managed by the
 * session-scoped card on /dashboard/settings/account, which talks to
 * `supabase.auth.passkey.*` in the browser and is a different surface entirely.
 * Keeping this route impersonation-only means the two can never be confused
 * into acting on the wrong account.
 *
 * Revocation is audited: removing a credential changes how a customer signs in.
 */
import { z } from "zod";
import { getAuthUser, type AuthUser } from "@/lib/auth";
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { logAdminAction } from "@/lib/admin/audit";
import { createSupabaseAdminPasskeyClient } from "@/lib/supabase/server";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * Resolve the tenant whose passkeys this request is about, or the response to
 * send instead. Shared by both verbs so the impersonation contract is stated
 * once rather than drifting between them.
 */
async function resolveTenant(): Promise<
  | { ok: true; userId: string; email: string; caller: AuthUser }
  | { ok: false; response: Response }
> {
  const user = await getAuthUser();
  if (!user?.email) {
    return { ok: false, response: errorResponse("UNAUTHORIZED", "Authentication required") };
  }
  const target = await resolveViewAsTargetUser(user);
  if (!target.impersonating) {
    return {
      ok: false,
      response: errorResponse(
        "FORBIDDEN",
        "This lists a tenant's passkeys while viewing as them. Your own passkeys are managed by the card on the Account page.",
        403
      )
    };
  }
  if (!target.userId || !target.email) {
    return {
      ok: false,
      response: errorResponse(
        "NOT_FOUND",
        "This tenant's owner has no login yet, so there are no passkeys",
        404
      )
    };
  }
  return { ok: true, userId: target.userId, email: target.email, caller: user };
}

export async function GET() {
  try {
    const tenant = await resolveTenant();
    if (!tenant.ok) return tenant.response;

    const db = await createSupabaseAdminPasskeyClient();
    const { data, error } = await db.auth.admin.passkey.listPasskeys({ userId: tenant.userId });
    if (error) {
      return errorResponse("INTERNAL_SERVER_ERROR", "Could not load this tenant's passkeys", 500);
    }

    return successResponse({
      passkeys: (data ?? []).map((p) => ({
        id: p.id,
        friendlyName: p.friendly_name ?? null,
        createdAt: p.created_at,
        lastUsedAt: p.last_used_at ?? null
      }))
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

const deleteSchema = z.object({ passkeyId: z.string().min(1) });

export async function DELETE(request: Request) {
  try {
    const tenant = await resolveTenant();
    if (!tenant.ok) return tenant.response;

    const body = deleteSchema.parse(await request.json());

    const db = await createSupabaseAdminPasskeyClient();
    const { error } = await db.auth.admin.passkey.deletePasskey({
      userId: tenant.userId,
      passkeyId: body.passkeyId
    });
    if (error) {
      return errorResponse("CONFLICT", error.message || "Could not remove that passkey");
    }

    // Best-effort, after the fact: the credential is already gone, so an audit
    // hiccup must not report a completed revocation as a failure.
    const businessId = await resolveActiveBusinessId(tenant.caller).catch(() => null);
    void logAdminAction({
      adminEmail: tenant.caller.email,
      action: "tenant_passkey_revoked",
      businessId,
      detail: { ownerEmail: tenant.email, passkeyId: body.passkeyId }
    });

    return successResponse({ removed: body.passkeyId });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
