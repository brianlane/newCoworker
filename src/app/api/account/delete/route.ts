/**
 * DELETE /api/account/delete — self-serve account deletion.
 *
 * BizBlasts-style guardrails, server-enforced:
 *   - The caller must re-enter their password (verified against Supabase
 *     auth with a throwaway non-persistent client — a hijacked-but-logged-in
 *     session can't delete the account).
 *   - The caller must type the exact DELETE confirmation phrase.
 *   - Paying tenants are refused (409) and directed through the
 *     cancellation lifecycle, which owns Stripe teardown, the data backup,
 *     and the grace window. Eligible states: no subscription row, pending
 *     (never paid), or already canceled.
 *
 * The deletion itself mirrors the admin delete-client subscription-less
 * branch: stop any attached VM, delete the auth user (only when this is the
 * owner's last business), then hard-delete the business row (cascades).
 */
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { readSupabaseEnv } from "@/lib/supabase/env";
import { getSubscription } from "@/lib/db/subscriptions";
import {
  deleteBusiness,
  getBusiness,
  listBusinessIdsByOwnerEmail
} from "@/lib/db/businesses";
import {
  DELETE_CONFIRM_PHRASE,
  resolveAccountDeletionEligibility
} from "@/lib/account/deletion";
import {
  HostingerClient,
  HostingerApiError,
  DEFAULT_HOSTINGER_BASE_URL
} from "@/lib/hostinger/client";
import { logger } from "@/lib/logger";

export const maxDuration = 120;

const schema = z.object({
  password: z.string().min(1, "Password is required"),
  confirm: z.string()
});

export async function DELETE(request: Request) {
  try {
    const user = await getAuthUser();
    // View-as is read-only — an impersonating admin must never be able to
    // delete a tenant's account from the tenant-facing surface.
    if (await isViewAsActive(user)) {
      return errorResponse("FORBIDDEN", "View-as is read-only; exit view-as to make changes", 403);
    }
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");

    const body = schema.parse(await request.json());
    if (body.confirm !== DELETE_CONFIRM_PHRASE) {
      return errorResponse(
        "VALIDATION_ERROR",
        `Type ${DELETE_CONFIRM_PHRASE} to confirm account deletion`
      );
    }

    // Server-side password re-verification. A throwaway client with the
    // anon key and no session persistence — the sign-in result is discarded;
    // we only care whether the credentials are valid.
    const env = readSupabaseEnv();
    const verifier = createClient(env.url, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { error: pwError } = await verifier.auth.signInWithPassword({
      email: user.email,
      password: body.password
    });
    if (pwError) {
      return errorResponse("FORBIDDEN", "Current password is incorrect", 403);
    }

    const db = await createSupabaseServiceClient();
    const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
    const { data: biz } = await db
      .from("businesses")
      .select("id")
      .in("id", activeBusinessId ? [activeBusinessId] : [])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!biz) return errorResponse("NOT_FOUND", "No business found for this account");
    const businessId = (biz as { id: string }).id;

    const business = await getBusiness(businessId, db);
    if (!business) return errorResponse("NOT_FOUND", "Business not found", 404);

    const subscription = await getSubscription(businessId, db);
    const eligibility = resolveAccountDeletionEligibility(subscription);
    if (!eligibility.eligible) {
      return errorResponse("CONFLICT", eligibility.reason, 409);
    }

    // Stop any attached VM first (mirrors the admin subscription-less
    // branch): once the business row is gone we lose the only DB
    // correlation to the box, so a running orphan would bill forever.
    if (business.hostinger_vps_id) {
      const vmId = Number.parseInt(business.hostinger_vps_id, 10);
      if (Number.isFinite(vmId)) {
        try {
          const hostinger = new HostingerClient({
            baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
            token: process.env.HOSTINGER_API_TOKEN ?? ""
          });
          await hostinger.stopVirtualMachine(vmId);
          logger.info("account.delete: stopped VM before self-delete", {
            businessId,
            virtualMachineId: vmId
          });
        } catch (err) {
          if (err instanceof HostingerApiError && err.status === 404) {
            logger.info("account.delete: VM already gone (404)", {
              businessId,
              virtualMachineId: vmId
            });
          } else {
            logger.error("account.delete: failed to stop VM", {
              businessId,
              virtualMachineId: vmId,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
      }
    }

    // Delete the auth user BEFORE the business row (so a transient auth
    // failure leaves everything intact for a retry), but only when this is
    // the owner's LAST business — multi-business owners keep their login.
    const ownedIds = await listBusinessIdsByOwnerEmail(user.email, db);
    const otherBusinesses = ownedIds.filter((id) => id !== businessId);
    if (otherBusinesses.length === 0) {
      const { error } = await db.auth.admin.deleteUser(user.userId);
      if (error && !/not found|does not exist/i.test(error.message ?? "")) {
        logger.error("account.delete: auth user delete failed; business row preserved", {
          businessId,
          supabaseUserId: user.userId,
          error: error.message
        });
        return errorResponse(
          "INTERNAL_SERVER_ERROR",
          "Account deletion failed; please retry or contact support",
          500
        );
      }
    }

    await deleteBusiness(businessId, db);
    logger.info("account.delete: self-serve deletion complete", {
      businessId,
      ownerEmail: user.email,
      authUserDeleted: otherBusinesses.length === 0,
      remainingBusinesses: otherBusinesses.length
    });

    return successResponse({ deleted: true, authUserDeleted: otherBusinesses.length === 0 });
  } catch (err) {
    return handleRouteError(err);
  }
}
