/**
 * Loads the {@link LifecycleContext} for a given business id. Kept separate
 * from the planner so the planner stays pure + side-effect-free.
 *
 * Used by:
 *   * /api/billing/cancel, /reactivate, /change-plan        (tenant-facing)
 *   * /api/admin/delete-client                              (admin)
 *   * supabase/functions/subscription-grace-sweep           (cron)
 *
 * Emits a typed `reason` when the business is not in a state we can act on
 * — cleaner than throwing.
 */

import { getSubscription } from "@/lib/db/subscriptions";
import { getBusiness } from "@/lib/db/businesses";
import { getCustomerProfileById } from "@/lib/db/customer-profiles";
import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import { logger } from "@/lib/logger";
import type { LifecycleContext } from "@/lib/billing/lifecycle";

export type LoadLifecycleContextResult =
  | { ok: true; context: LifecycleContext; vpsHost: string | null }
  | { ok: false; reason: "business_not_found" | "subscription_not_found" };

export async function loadLifecycleContextForBusiness(
  businessId: string,
  opts: { ownerAuthUserId?: string } = {}
): Promise<LoadLifecycleContextResult> {
  const business = await getBusiness(businessId);
  if (!business) return { ok: false, reason: "business_not_found" };
  const subscription = await getSubscription(businessId);
  if (!subscription) return { ok: false, reason: "subscription_not_found" };

  const profile = subscription.customer_profile_id
    ? await getCustomerProfileById(subscription.customer_profile_id)
    : business.customer_profile_id
      ? await getCustomerProfileById(business.customer_profile_id)
      : null;

  // We store the Hostinger VM id as text on `businesses`; coerce to number
  // for client calls. Null-safe on pre-lifecycle rows.
  const vmIdRaw = business.hostinger_vps_id;
  const virtualMachineId =
    vmIdRaw && /^\d+$/.test(vmIdRaw) ? Number.parseInt(vmIdRaw, 10) : null;

  // We don't persist the public IP anywhere, so look it up from Hostinger
  // once per lifecycle invocation. If the VM is already gone (e.g. grace-
  // sweep runs after cancelBillingSubscription has destroyed it), the
  // client returns 404 → we leave vpsHost null and the executor skips the
  // SSH backup op. That's correct for post-destroy wipes; for active-sub
  // cancels we should always have a VM to reach.
  let vpsHost: string | null = null;
  if (virtualMachineId !== null) {
    try {
      const client = new HostingerClient({
        baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
        token: process.env.HOSTINGER_API_TOKEN ?? ""
      });
      const vm = await client.getVirtualMachine(virtualMachineId);
      const ipv4 =
        vm.ipv4?.find((addr) => addr?.address)?.address ?? null;
      vpsHost = ipv4;
    } catch (err) {
      logger.warn("loadLifecycleContextForBusiness: Hostinger VM lookup failed; continuing without vpsHost", {
        businessId,
        virtualMachineId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const context: LifecycleContext = {
    subscription,
    ownerEmail: business.owner_email,
    ownerAuthUserId: opts.ownerAuthUserId,
    profile,
    virtualMachineId,
    vpsHost
  };
  return { ok: true, context, vpsHost };
}
