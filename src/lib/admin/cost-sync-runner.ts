/**
 * Production wiring for the platform cost sync — shared by the internal
 * cron route (/api/internal/platform-cost-sync) and the admin Sync-now
 * route (/api/admin/cost-sync) so the two can never drift.
 */

import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import {
  listBusinessVpsAssignments,
  listStripeCustomerBusinessIds,
  listTenantDids,
  replaceHostingerVpsCosts,
  replaceStripeFeeWindow,
  replaceTelnyxCostWindow
} from "@/lib/db/platform-costs";
import { upsertAdminPlatformSetting } from "@/lib/admin/platform-settings";
import { getStripe } from "@/lib/stripe/client";
import {
  PLATFORM_COST_SYNC_STATUS_KEY,
  runPlatformCostSync,
  stripeCustomerIdFromSource,
  type PlatformCostSyncStatus,
  type StripeFeeTransaction,
  type TelnyxSyncRange
} from "@/lib/admin/cost-sync";

/**
 * Every balance transaction settled at or after `sinceUnix`, normalized to
 * {@link StripeFeeTransaction}.
 *
 * `expand: ["data.source"]` is what makes attribution possible: an
 * unexpanded balance transaction carries only the source's id, so there
 * would be no customer to map to a tenant. Auto-pagination walks the whole
 * window rather than the first page, a year of charges is well past
 * Stripe's 100-per-page cap.
 */
async function fetchStripeFeeTransactions(sinceUnix: number): Promise<StripeFeeTransaction[]> {
  const stripe = getStripe();
  const transactions: StripeFeeTransaction[] = [];
  for await (const txn of stripe.balanceTransactions.list({
    created: { gte: sinceUnix },
    limit: 100,
    expand: ["data.source"]
  })) {
    transactions.push({
      type: txn.type,
      amountCents: txn.amount,
      feeCents: txn.fee,
      netCents: txn.net,
      createdUnix: txn.created,
      customerId: stripeCustomerIdFromSource(txn.source)
    });
  }
  return transactions;
}

export async function runProductionPlatformCostSync(options?: {
  telnyxRange?: TelnyxSyncRange;
}): Promise<PlatformCostSyncStatus> {
  const hostinger = new HostingerClient({
    /* c8 ignore next 2 -- trivial env-default fallbacks */
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token: process.env.HOSTINGER_API_TOKEN ?? ""
  });

  return runPlatformCostSync(
    {
      telnyxApiKey: process.env.TELNYX_API_KEY?.trim() || null,
      listBillingSubscriptions: () => hostinger.listBillingSubscriptions(),
      listVirtualMachines: () => hostinger.listVirtualMachines(),
      listTenantDids,
      listBusinessVpsAssignments,
      replaceTelnyxCostWindow,
      replaceHostingerVpsCosts,
      // Null (rather than a function that throws) so a missing key records
      // "skipped", the same shape as the Telnyx side, instead of surfacing
      // as a sync failure with a stack-shaped message.
      listStripeBalanceTransactions: process.env.STRIPE_SECRET_KEY?.trim()
        ? fetchStripeFeeTransactions
        : null,
      listStripeCustomerBusinessIds,
      replaceStripeFeeWindow,
      recordStatus: (status) =>
        upsertAdminPlatformSetting(PLATFORM_COST_SYNC_STATUS_KEY, status)
    },
    { telnyxRange: options?.telnyxRange }
  );
}
