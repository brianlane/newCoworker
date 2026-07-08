/**
 * Team access (enterprise): manage additional logins for one business.
 *
 * GET    ?businessId=            → member roster (manager+; owner implicit)
 * POST   { businessId, email, role, employeeId? } → invite. Creates the
 *        membership row, then delivers the invite: a brand-new address gets
 *        Supabase's auth invite (password-set link IS the invitation, the
 *        bizblasts mechanic); an existing login gets a branded
 *        "you've been added" email. Email delivery is best-effort — the
 *        grant is the row, and the response reports how it was delivered.
 * PATCH  { businessId, memberId, role }           → change a member's role
 * DELETE { businessId, memberId }                 → revoke access
 *
 * Auth: requireBusinessRole(businessId, "manage_team") — owner or manager
 * (platform admin passes). Inviting/role-changing is enterprise-gated
 * server-side; revoke + list work on any tier so downgraded businesses can
 * shed members. View-as stays read-only: writes are refused.
 */
import { z } from "zod";
import { authUserExistsByEmail, getAuthUser, requireBusinessRole } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import {
  inviteBusinessMember,
  listBusinessMembers,
  updateBusinessMemberRole,
  revokeBusinessMember,
  BusinessMemberConflictError
} from "@/lib/db/business-members";
import { MEMBER_ROLES } from "@/lib/authz/policy";
import { assertTeamAccessAllowed, TeamAccessValidationError } from "@/lib/team/tier-gate";
import { getBusiness } from "@/lib/db/businesses";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { buildTeamInviteEmail } from "@/lib/email/templates/team-invite";
import { sendOwnerEmail } from "@/lib/email/client";
import { logger } from "@/lib/logger";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/** How the invitation reached the invitee (or why it didn't). */
type InviteDelivery = "auth_invite" | "notice_email" | "none";

async function refuseViewAsWrite() {
  const user = await getAuthUser();
  if (await isViewAsActive(user)) {
    return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
  }
  return null;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const businessId = z.string().uuid().parse(url.searchParams.get("businessId") ?? "");
    await requireBusinessRole(businessId, "manage_team");
    const members = await listBusinessMembers(businessId);
    return successResponse({ members });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid query");
    }
    return handleRouteError(err);
  }
}

const inviteSchema = z.object({
  businessId: z.string().uuid(),
  email: z.string().trim().email().max(320),
  role: z.enum(MEMBER_ROLES),
  employeeId: z.string().uuid().nullish()
});

export async function POST(request: Request) {
  try {
    const body = inviteSchema.parse(await request.json());
    const user = await requireBusinessRole(body.businessId, "manage_team");
    const viewAsRefusal = await refuseViewAsWrite();
    if (viewAsRefusal) return viewAsRefusal;

    await assertTeamAccessAllowed(body.businessId);

    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");
    const email = body.email.trim().toLowerCase();
    // The owner already holds the top role; a membership row for them would
    // just shadow it confusingly.
    if ((business.owner_email ?? "").trim().toLowerCase() === email) {
      return errorResponse("VALIDATION_ERROR", "That email is the business owner");
    }

    const member = await inviteBusinessMember({
      businessId: body.businessId,
      email,
      role: body.role,
      invitedBy: user.email ?? user.userId,
      employeeId: body.employeeId ?? null
    });

    // Delivery is best-effort: the membership row IS the grant. A brand-new
    // address gets the Supabase auth invite (its password-set link doubles
    // as the invitation); an existing login gets a branded notice email.
    let delivery: InviteDelivery = "none";
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    try {
      const exists = await authUserExistsByEmail(email);
      if (!exists) {
        const db = await createSupabaseServiceClient();
        const { error } = await db.auth.admin.inviteUserByEmail(email, {
          redirectTo: `${appUrl}/reset-password`
        });
        if (error) throw new Error(error.message);
        delivery = "auth_invite";
      } else {
        const apiKey = process.env.RESEND_API_KEY;
        if (apiKey) {
          const { subject, text, html } = buildTeamInviteEmail({
            businessName: business.name,
            role: body.role,
            invitedBy: user.email ?? "The business owner",
            recipientEmail: email,
            siteUrl: appUrl
          });
          const messageId = await sendOwnerEmail(apiKey, email, subject, { text, html });
          if (messageId) delivery = "notice_email";
        }
      }
    } catch (err) {
      logger.error("team invite email failed (non-fatal)", {
        businessId: body.businessId,
        memberId: member.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    return successResponse({ member, delivery });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    if (err instanceof BusinessMemberConflictError) {
      return errorResponse("CONFLICT", err.message);
    }
    if (err instanceof TeamAccessValidationError) {
      return errorResponse("FORBIDDEN", err.message, 403);
    }
    return handleRouteError(err);
  }
}

const roleSchema = z.object({
  businessId: z.string().uuid(),
  memberId: z.string().uuid(),
  role: z.enum(MEMBER_ROLES)
});

export async function PATCH(request: Request) {
  try {
    const body = roleSchema.parse(await request.json());
    await requireBusinessRole(body.businessId, "manage_team");
    const viewAsRefusal = await refuseViewAsWrite();
    if (viewAsRefusal) return viewAsRefusal;
    await assertTeamAccessAllowed(body.businessId);

    const updated = await updateBusinessMemberRole(body.businessId, body.memberId, body.role);
    if (!updated) return errorResponse("NOT_FOUND", "Member not found (or revoked)");
    return successResponse({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    if (err instanceof TeamAccessValidationError) {
      return errorResponse("FORBIDDEN", err.message, 403);
    }
    return handleRouteError(err);
  }
}

const revokeSchema = z.object({
  businessId: z.string().uuid(),
  memberId: z.string().uuid()
});

export async function DELETE(request: Request) {
  try {
    const body = revokeSchema.parse(await request.json());
    // Deliberately NOT tier-gated: a downgraded business must always be able
    // to shed members.
    await requireBusinessRole(body.businessId, "manage_team");
    const viewAsRefusal = await refuseViewAsWrite();
    if (viewAsRefusal) return viewAsRefusal;

    const revoked = await revokeBusinessMember(body.businessId, body.memberId);
    if (!revoked) return errorResponse("NOT_FOUND", "Member not found (or already revoked)");
    return successResponse({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
