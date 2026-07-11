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
import {
  listAccessibleBusinesses,
  resolveActiveBusinessIdForAction
} from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { readSupabaseEnv } from "@/lib/supabase/env";
import type { SubscriptionRow } from "@/lib/db/subscriptions";
import { deleteBusiness, getBusiness } from "@/lib/db/businesses";
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
    // Owner-only (`manage_billing` = owner in the role policy): account
    // deletion is at least as destructive as billing cancel, so a manager
    // on the tenant must not be able to hard-delete the business.
    const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_billing");
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

    // FAIL-CLOSED billing lookup: getSubscription collapses query errors
    // into null, which here would read as "never paid" and wave a live
    // subscription through the gate. Query directly and refuse on any read
    // error — a transient DB hiccup must block deletion, not allow it.
    const { data: subRow, error: subError } = await db
      .from("subscriptions")
      .select("status, grace_ends_at, wiped_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (subError) {
      logger.error("account.delete: subscription lookup failed; refusing (fail closed)", {
        businessId,
        error: subError.message
      });
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        "Could not verify billing state; please retry",
        500
      );
    }
    const eligibility = resolveAccountDeletionEligibility(
      (subRow as Pick<SubscriptionRow, "status" | "grace_ends_at" | "wiped_at"> | null) ?? null
    );
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
      } else {
        // Mirrors admin delete-client: a non-numeric id (e.g. a corrupted
        // row) means we can't stop the VM through Hostinger — surface it
        // loudly so an operator can chase the orphan before it bills on.
        logger.warn("account.delete: hostinger_vps_id is non-numeric; cannot stop VM", {
          businessId,
          hostingerVpsId: business.hostinger_vps_id
        });
      }
    }

    // Does this login keep access to ANY other business — owned (matched
    // case-insensitively; owner_email is not lowercased by schema) or via a
    // business_members role? If so the auth user must survive: deleting it
    // would kick a manager/staff member out of every other tenant too.
    const otherAccessible = (await listAccessibleBusinesses(user, db)).filter(
      (b) => b.businessId !== businessId
    );

    // Delete the business row FIRST, then the auth user. If the auth delete
    // fails afterwards, the leftover login is harmless (it owns nothing and
    // the user asked for deletion themselves) — whereas the reverse order
    // would lock the owner out while their data still exists, with no way
    // to sign in and retry.
    await deleteBusiness(businessId, db);

    let authUserDeleted = false;
    if (otherAccessible.length === 0) {
      try {
        const { error } = await db.auth.admin.deleteUser(user.userId);
        if (!error || /not found|does not exist/i.test(error.message ?? "")) {
          authUserDeleted = true;
        } else {
          logger.error("account.delete: auth user delete failed after business delete", {
            businessId,
            supabaseUserId: user.userId,
            error: error.message
          });
        }
      } catch (err) {
        logger.error("account.delete: auth user delete threw after business delete", {
          businessId,
          supabaseUserId: user.userId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    logger.info("account.delete: self-serve deletion complete", {
      businessId,
      ownerEmail: user.email,
      authUserDeleted,
      remainingBusinesses: otherAccessible.length
    });

    return successResponse({ deleted: true, authUserDeleted });
  } catch (err) {
    return handleRouteError(err);
  }
}
