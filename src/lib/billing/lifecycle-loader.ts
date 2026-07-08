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
import { getTelnyxVoiceRouteForBusiness } from "@/lib/db/telnyx-routes";
import { getActiveVpsSshKeyForBusiness } from "@/lib/db/vps-ssh-keys";
import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import { providerUsesHostingerLifecycle, resolveVpsProvider } from "@/lib/vps/provider";
import { logger } from "@/lib/logger";
import type { LifecycleContext } from "@/lib/billing/lifecycle";

export type LoadLifecycleContextResult =
  | { ok: true; context: LifecycleContext; vpsHost: string | null }
  | { ok: false; reason: "business_not_found" | "subscription_not_found" };

export async function loadLifecycleContextForBusiness(
  businessId: string,
  opts: { ownerAuthUserId?: string; subscription?: Awaited<ReturnType<typeof getSubscription>> } = {}
): Promise<LoadLifecycleContextResult> {
  const business = await getBusiness(businessId);
  if (!business) return { ok: false, reason: "business_not_found" };
  const subscription = opts.subscription ?? (await getSubscription(businessId));
  if (!subscription) return { ok: false, reason: "subscription_not_found" };

  const profile = subscription.customer_profile_id
    ? await getCustomerProfileById(subscription.customer_profile_id)
    : business.customer_profile_id
      ? await getCustomerProfileById(business.customer_profile_id)
      : null;

  // Provider axis: non-hostinger boxes (BYOS / OVH) have no Hostinger VM
  // id, no Hostinger IP lookup, and skip every Hostinger op in the planner.
  const vpsProvider = resolveVpsProvider(business.vps_provider);
  const hostingerManaged = providerUsesHostingerLifecycle(vpsProvider);

  // We store the Hostinger VM id as text on `businesses`; coerce to number
  // for client calls. Null-safe on pre-lifecycle rows. Non-hostinger rows
  // carry a non-numeric box id (OVH service name / byos sentinel), which
  // this regex already rejects — the provider gate makes that explicit.
  const vmIdRaw = business.hostinger_vps_id;
  const virtualMachineId =
    hostingerManaged && vmIdRaw && /^\d+$/.test(vmIdRaw)
      ? Number.parseInt(vmIdRaw, 10)
      : null;

  // We don't persist the public IP for Hostinger boxes, so look it up from
  // Hostinger once per lifecycle invocation. If the VM is already gone
  // (e.g. grace-sweep runs after a manual hPanel deletion or billing
  // lapse), the client returns 404 → we leave vpsHost null and the
  // executor skips the SSH backup op. That's correct for post-destroy
  // wipes; for active-sub cancels we should always have a VM to reach.
  //
  // BYOS/OVH boxes persist their host on the active `vps_ssh_keys` row
  // instead (there is no live provider IP-lookup path for them), so the
  // SSH backup op still runs against customer-owned / Canadian boxes.
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
  } else if (!hostingerManaged) {
    try {
      const sshKey = await getActiveVpsSshKeyForBusiness(businessId);
      vpsHost = sshKey?.host ?? null;
    } catch (err) {
      logger.warn(
        "loadLifecycleContextForBusiness: ssh-key host lookup failed; continuing without vpsHost",
        {
          businessId,
          vpsProvider,
          error: err instanceof Error ? err.message : String(err)
        }
      );
    }
  }

  // The tenant's DID, so terminal wipes can release it at Telnyx. Best-effort:
  // a lookup failure only skips the release op (the grace-sweep retries the
  // whole plan on its next tick anyway), never blocks the cancel itself.
  let didE164: string | null = null;
  try {
    didE164 = (await getTelnyxVoiceRouteForBusiness(businessId))?.to_e164 ?? null;
  } catch (err) {
    logger.warn("loadLifecycleContextForBusiness: DID route lookup failed; continuing without didE164", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  const context: LifecycleContext = {
    subscription,
    ownerEmail: business.owner_email,
    ownerName: business.owner_name ?? null,
    businessTimezone: business.timezone ?? null,
    ownerAuthUserId: opts.ownerAuthUserId,
    profile,
    virtualMachineId,
    vpsSize: business.vps_size ?? null,
    vpsProvider: business.vps_provider ?? null,
    vpsHost,
    didE164
  };
  return { ok: true, context, vpsHost };
}
