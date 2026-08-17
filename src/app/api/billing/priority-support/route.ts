/**
 * POST   /api/billing/priority-support  start the $400/month add-on
 * DELETE /api/billing/priority-support  wind it down at period end
 *
 * Priority support is the tenant's SECOND Stripe subscription, month to month,
 * independent of their membership term. POST returns `{ checkoutUrl }` so the
 * client can `window.location = checkoutUrl`; the Stripe webhook plants the
 * mirror row and opens the coverage window on success.
 *
 * DELETE never revokes coverage. It sets `cancel_at_period_end`, so the tenant
 * keeps the days they already paid for and the countdown on the billing page
 * simply stops resetting.
 *
 * Rules live in src/lib/billing/priority-support.ts (enterprise cannot buy it,
 * one live subscription per tenant, an active membership is required), so this
 * route only maps failure reasons onto HTTP.
 */
import type { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser, type AuthUser } from "@/lib/auth";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { resolveViewAsTargetUser } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  startPrioritySupport,
  cancelPrioritySupport,
  type PrioritySupportFailure
} from "@/lib/billing/priority-support";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

/**
 * Reason to HTTP mapping, shared by both verbs so they cannot drift.
 *
 * The explicit return type matters: without it TypeScript infers
 * `NextResponse | undefined` from the switch and every caller has to
 * null-check a value that can never be null.
 */
function failureResponse(reason: PrioritySupportFailure): NextResponse {
  switch (reason) {
    case "not_purchasable_for_tier":
      return errorResponse(
        "CONFLICT",
        "Enterprise plans already include priority support at no extra cost",
        409
      );
    case "already_subscribed":
      return errorResponse("CONFLICT", "Priority support is already active", 409);
    case "no_active_membership":
      return errorResponse(
        "CONFLICT",
        "An active subscription is required before adding priority support",
        409
      );
    case "not_subscribed":
      return errorResponse("NOT_FOUND", "Priority support is not active");
  }
}

/**
 * Explicitly tagged rather than inferred: TypeScript widens two differently
 * shaped object returns into a union where BOTH members declare `error`
 * (one as `error?: undefined`), which makes an `"error" in resolved` check
 * useless as a discriminant and leaks `undefined` into every caller.
 */
type ResolvedBusiness =
  | { ok: false; response: NextResponse }
  | { ok: true; user: AuthUser; business: { id: string; tier: string | null } };

async function resolveBusiness(): Promise<ResolvedBusiness> {
  const user = await getAuthUser();
  if (!user?.email) {
    return { ok: false, response: errorResponse("UNAUTHORIZED", "Authentication required") };
  }

  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_billing");
  if (!activeBusinessId) {
    return { ok: false, response: errorResponse("NOT_FOUND", "Business not found") };
  }

  const db = await createSupabaseServiceClient();
  const { data: business } = await db
    .from("businesses")
    .select("id, tier")
    .eq("id", activeBusinessId)
    .maybeSingle();
  if (!business) {
    return { ok: false, response: errorResponse("NOT_FOUND", "Business not found") };
  }

  return { ok: true, user, business: business as { id: string; tier: string | null } };
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // Body is optional and currently empty; parse defensively so a client that
    // posts nothing does not 500 on request.json().
    await request
      .json()
      .then((body) => z.object({}).passthrough().parse(body))
      .catch(() => ({}));

    const resolved = await resolveBusiness();
    if (!resolved.ok) return resolved.response;
    const { user, business } = resolved;

    // Payer identity, NOT caller identity: under admin view-as the charge
    // belongs to the tenant, so Checkout must open under the TENANT's address
    // rather than the operator's. Same rule the white-glove checkout follows.
    const payer = await resolveViewAsTargetUser(user);

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const result = await startPrioritySupport({
      businessId: business.id,
      tier: business.tier,
      actorEmail: payer.email ?? user.email ?? "",
      userId: user.userId,
      successUrl: `${appUrl}/dashboard/billing?prioritySupport=success`,
      cancelUrl: `${appUrl}/dashboard/billing?prioritySupport=cancelled`
    });

    if (!result.ok) return failureResponse(result.reason);
    return successResponse({ checkoutUrl: result.value.checkoutUrl });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}

export async function DELETE(): Promise<NextResponse> {
  try {
    const resolved = await resolveBusiness();
    if (!resolved.ok) return resolved.response;
    const { business } = resolved;

    const result = await cancelPrioritySupport(business.id);
    if (!result.ok) return failureResponse(result.reason);
    return successResponse({ ok: true, coverageEndsAt: result.value.coverageEndsAt });
  } catch (err) {
    return handleRouteError(err);
  }
}
