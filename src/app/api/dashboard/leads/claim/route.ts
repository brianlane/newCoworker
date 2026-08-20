/**
 * POST /api/dashboard/leads/claim
 *   body: { businessId: <uuid>, contactKey: <E.164 | short code | email: key> }
 *   -> 200 { claimed: true, alreadyMine, ownerEmployeeId, ownerName }
 *   -> 403 when the caller's login maps to no roster member
 *   -> 404 when no contact row exists behind the key
 *   -> 409 when somebody else already owns the contact; the body carries
 *      `error.ownerName` (null when their roster row is gone) so the client
 *      can render a localized "already claimed by <name>" toast instead of
 *      parsing the English message.
 *
 * The logic (caller -> roster member mapping, the race-safe null-owner
 * compare-and-swap, the claim stamp, the owner_assigned event) lives in
 * src/lib/leads/claim.ts; this route only authenticates, validates, rate
 * limits, and maps outcomes to statuses.
 *
 * Auth: requireBusinessRole(businessId, "operate_messages"), the same bar as
 * the quick editor's owner dropdown (both write contact ownership), which
 * staff hold, claiming is the point of the button for them.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { claimLeadForCaller } from "@/lib/leads/claim";
import { classifyContactKey } from "../../../../../../supabase/functions/_shared/contact_key";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const bodySchema = z.object({
  businessId: z.string().uuid(),
  // Any contact KEY the contact routes accept: E.164, bare short code, or
  // an `email:` key, all three appear on the board and the customers list.
  contactKey: z.string().refine((v) => classifyContactKey(v) !== null, {
    message: "Not a contact key"
  })
});

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const { businessId, contactKey } = bodySchema.parse(await request.json());

    if (!user.isAdmin) await requireBusinessRole(businessId, "operate_messages");

    const limiter = rateLimit(`lead-claim:${businessId}:${user.userId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const result = await claimLeadForCaller({
      businessId,
      contactKey,
      callerEmail: user.email
    });

    switch (result.outcome) {
      case "not_linked":
        return errorResponse(
          "FORBIDDEN",
          "Your login isn't linked to a team-roster member, so it can't claim leads. Ask a manager to link it (Settings, Team access)."
        );
      case "not_found":
        return errorResponse("NOT_FOUND", "Contact not found");
      case "already_owned":
        // Same envelope errorResponse builds, plus the structured owner name
        // the client toast interpolates (localized client-side).
        return NextResponse.json(
          {
            ok: false,
            error: {
              code: "CONFLICT",
              message: result.ownerName
                ? `Already claimed by ${result.ownerName}.`
                : "Already claimed by another teammate.",
              ownerName: result.ownerName
            }
          },
          { status: 409 }
        );
      default:
        return successResponse({
          claimed: true,
          alreadyMine: result.outcome === "already_mine",
          ownerEmployeeId: result.ownerEmployeeId,
          ownerName: result.ownerName
        });
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
