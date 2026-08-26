/**
 * Platform cost sync, the productized version of the one-shot canvas pull
 * (debug/pull-cost-data.ts), run daily by cron and on demand from the admin
 * Costs page:
 *
 *   1. Telnyx `/v2/detail_records` (invoice-grade MDRs: our real per-unit
 *      rate + 10DLC carrier fees) aggregated per UTC day / tenant /
 *      record type / direction into `telnyx_cost_daily`. Records are
 *      attributed to a tenant when the MDR's cli/cld matches one of the
 *      tenant's DIDs (messaging from-number + routed voice DIDs);
 *      unmatched records land with business_id NULL, the costs page
 *      shows that bucket as a leak detector.
 *   2. The Hostinger billing-subscription list (KVM boxes only), joined to
 *      VMs and live tenant assignments, snapshotted into
 *      `hostinger_vps_costs`.
 *
 * The two sides fail independently: a Telnyx outage must not lose the
 * Hostinger snapshot or vice versa. The run's outcome is recorded in
 * `admin_platform_settings` under {@link PLATFORM_COST_SYNC_STATUS_KEY}
 * (the "Last synced" line + Sync-now feedback on the Costs page).
 *
 * All dependencies are injected; the internal route wires production
 * implementations. Nothing here bills anyone, operator telemetry only.
 */

import type { BillingSubscription, VirtualMachine } from "@/lib/hostinger/client";
import { cycleContradictsNextBilling } from "@/lib/vps/box-term";
import type {
  HostingerVpsCostInsert,
  StripeFeeMonthlyInsert,
  TelnyxCostDailyInsert
} from "@/lib/db/platform-costs";

export const PLATFORM_COST_SYNC_STATUS_KEY = "platform_cost_sync_status";

export type TelnyxSyncRange = "last_7_days" | "last_30_days" | "last_90_days";

const RANGE_DAYS: Record<TelnyxSyncRange, number> = {
  last_7_days: 7,
  last_30_days: 30,
  last_90_days: 90
};

export type PlatformCostSyncStatus = {
  lastSyncAt: string;
  ok: boolean;
  telnyxRange: TelnyxSyncRange;
  telnyxRows: number;
  telnyxError: string | null;
  hostingerRows: number;
  hostingerError: string | null;
  /** How many months back the Stripe balance-transaction pull covered. */
  stripeMonths: number;
  stripeRows: number;
  stripeError: string | null;
};

/**
 * How far back the Stripe fee pull reaches, in whole months.
 *
 * Wider than the Telnyx window on purpose: a term plan charges ONCE every
 * 12 or 24 months, so a 30-day window would show no charges at all for a
 * biennial tenant and their fee rate could never be observed. Older rows
 * survive each sync (the replace only clears months at or after the window
 * start), so history accumulates beyond this window rather than being
 * capped by it.
 */
export const STRIPE_FEE_WINDOW_MONTHS = 12;

/** Parse the stored status jsonb; null when missing or unusable. */
export function parsePlatformCostSyncStatus(raw: unknown): PlatformCostSyncStatus | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.lastSyncAt !== "string") return null;
  return {
    lastSyncAt: r.lastSyncAt,
    ok: r.ok === true,
    telnyxRange:
      r.telnyxRange === "last_30_days" || r.telnyxRange === "last_90_days"
        ? r.telnyxRange
        : "last_7_days",
    telnyxRows: typeof r.telnyxRows === "number" ? r.telnyxRows : 0,
    telnyxError: typeof r.telnyxError === "string" ? r.telnyxError : null,
    hostingerRows: typeof r.hostingerRows === "number" ? r.hostingerRows : 0,
    hostingerError: typeof r.hostingerError === "string" ? r.hostingerError : null,
    // Status rows written before the Stripe side existed carry none of
    // these keys; they read as "nothing synced, no error" rather than
    // failing the whole parse and blanking the Costs page's sync line.
    stripeMonths: typeof r.stripeMonths === "number" ? r.stripeMonths : 0,
    stripeRows: typeof r.stripeRows === "number" ? r.stripeRows : 0,
    stripeError: typeof r.stripeError === "string" ? r.stripeError : null
  };
}

export type TenantDid = { businessId: string; e164: string };

/**
 * One Stripe balance transaction, normalized to the few fields the fee
 * aggregate needs. The Stripe SDK call itself is injected (see
 * cost-sync-runner.ts) so this module stays testable without a Stripe
 * client, matching how the Hostinger lists are supplied.
 */
export type StripeFeeTransaction = {
  /** Balance transaction `type`, e.g. "charge", "payment", "refund". */
  type: string;
  /** Gross amount in cents; negative for refunds and negative adjustments. */
  amountCents: number;
  /** Stripe's cut in cents. */
  feeCents: number;
  /** What actually landed, in cents. */
  netCents: number;
  /** Settlement instant, unix seconds. */
  createdUnix: number;
  /** Customer on the source charge; null when Stripe reported none. */
  customerId: string | null;
};

/**
 * Balance-transaction types that represent a CARD CHARGE, and therefore
 * carry Stripe's per-charge fixed fee. Only these increment `charge_count`,
 * which is the $0.30 multiplier when a rate is backed out of the totals; a
 * refund moves money without adding another fixed fee.
 */
const STRIPE_CHARGE_TYPES = new Set(["charge", "payment"]);

export type PlatformCostSyncDeps = {
  /** Null/empty skips the Telnyx side with a recorded error (mirrors pull-cost-data). */
  telnyxApiKey: string | null;
  fetchImpl?: typeof fetch;
  /** Injectable backoff sleeper (tests pass an instant one). */
  sleepImpl?: (ms: number) => Promise<void>;
  listBillingSubscriptions: () => Promise<BillingSubscription[]>;
  listVirtualMachines: () => Promise<VirtualMachine[]>;
  /** Every tenant DID (messaging from-number + routed voice DIDs). */
  listTenantDids: () => Promise<TenantDid[]>;
  /** vm_id → owning business for non-wiped tenants. */
  listBusinessVpsAssignments: () => Promise<Array<{ businessId: string; vmId: number }>>;
  replaceTelnyxCostWindow: (
    windowStartDay: string,
    rows: TelnyxCostDailyInsert[]
  ) => Promise<void>;
  replaceHostingerVpsCosts: (rows: HostingerVpsCostInsert[]) => Promise<void>;
  /**
   * Stripe balance transactions settled at or after `sinceUnix`. Null skips
   * the Stripe side with a recorded error, mirroring `telnyxApiKey`.
   */
  listStripeBalanceTransactions:
    | ((sinceUnix: number) => Promise<StripeFeeTransaction[]>)
    | null;
  /** Stripe customer id → owning business, for attributing each transaction. */
  listStripeCustomerBusinessIds: () => Promise<
    Array<{ businessId: string; stripeCustomerId: string }>
  >;
  replaceStripeFeeWindow: (
    windowStartMonth: string,
    rows: StripeFeeMonthlyInsert[]
  ) => Promise<void>;
  recordStatus: (status: PlatformCostSyncStatus) => Promise<void>;
  now?: Date;
};

const usdToMicros = (usd: number): number => Math.round(usd * 1_000_000);

function num(v: unknown): number {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Last-10-digit suffix used to match MDR cli/cld to tenant DIDs. */
export function didSuffix(e164: string): string | null {
  const digits = e164.replace(/[^+\d]/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** Longest sender label we store; real Telnyx sender ids are far shorter. */
const SENDER_LABEL_MAX = 64;

/**
 * Label an unattributed record's sender from its legs, preferred leg first.
 * Falls back to the other leg when ours is blank (Telnyx omits a leg on some
 * failed records) and to null when both are, so the column never stores an
 * empty string that would read as a named sender in the UI.
 */
export function senderLabel(legs: readonly string[]): string | null {
  for (const leg of legs) {
    const trimmed = leg.trim();
    if (trimmed.length > 0) return trimmed.slice(0, SENDER_LABEL_MAX);
  }
  return null;
}

/** UTC YYYY-MM-DD for "today minus `days`". */
export function windowStartDayUtc(now: Date, days: number): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * First day (UTC) of the calendar month `months` back from `now`. Calendar
 * arithmetic, not 30-day subtraction, so the window boundary always lands
 * on a month start and matches how the fee rows are bucketed.
 */
export function windowStartMonthUtc(now: Date, months: number): string {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - Math.max(months, 0), 1)
  );
  return start.toISOString().slice(0, 10);
}

/**
 * Pull the Stripe customer id out of an expanded balance-transaction
 * `source` (a Charge, Refund, Payout, …). Returns null when the source is
 * unexpanded (a bare id string), absent, or carries no customer, all of
 * which mean "cannot attribute to a tenant" rather than an error.
 *
 * `unknown` in rather than a Stripe type so this stays testable without a
 * Stripe client; the runner passes the SDK object straight through.
 */
export function stripeCustomerIdFromSource(source: unknown): string | null {
  if (source === null || typeof source !== "object") return null;
  const customer = (source as { customer?: unknown }).customer;
  if (typeof customer === "string") return customer || null;
  if (customer !== null && typeof customer === "object") {
    const id = (customer as { id?: unknown }).id;
    return typeof id === "string" && id ? id : null;
  }
  return null;
}

/**
 * Aggregate Stripe balance transactions into per-month/tenant fee rows.
 *
 * Transactions settled before the window start are dropped: an earlier sync
 * of a wider window already persisted them, and the replace only clears
 * months at or after the start, so keeping them would double-count.
 *
 * Every transaction type contributes to gross/fee/net, so the totals
 * reconcile against Stripe's own net volume. Only real charges (see
 * {@link STRIPE_CHARGE_TYPES}) additionally contribute to the charge-only
 * subtotals and `charge_count`, and those are what a fee RATE is derived
 * from: Stripe keeps the fee when a charge is refunded, so a refund folded
 * into the rate inputs would lower gross while the fee stood still and
 * report a rate that is too high while still looking plausible.
 *
 * A transaction whose customer matches no subscription row lands under a
 * null `business_id`, the same unattributed bucket convention the Telnyx
 * sync uses, and the honest answer for account-level fees that belong to no
 * tenant.
 */
export function aggregateStripeFees(params: {
  transactions: StripeFeeTransaction[];
  customerToBusiness: Map<string, string>;
  windowStartMonth: string;
}): StripeFeeMonthlyInsert[] {
  const buckets = new Map<string, StripeFeeMonthlyInsert>();
  for (const txn of params.transactions) {
    if (!Number.isFinite(txn.createdUnix)) continue;
    const settled = new Date(txn.createdUnix * 1000);
    if (Number.isNaN(settled.getTime())) continue;
    const monthStart = `${settled.toISOString().slice(0, 7)}-01`;
    if (monthStart < params.windowStartMonth) continue;

    const businessId =
      txn.customerId === null ? null : (params.customerToBusiness.get(txn.customerId) ?? null);

    const key = `${monthStart}|${businessId ?? ""}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        month_start: monthStart,
        business_id: businessId,
        gross_cents: 0,
        fee_cents: 0,
        net_cents: 0,
        charge_gross_cents: 0,
        charge_fee_cents: 0,
        charge_count: 0
      };
      buckets.set(key, bucket);
    }
    const grossCents = Math.round(num(txn.amountCents));
    const feeCents = Math.round(num(txn.feeCents));
    bucket.gross_cents += grossCents;
    bucket.fee_cents += feeCents;
    bucket.net_cents += Math.round(num(txn.netCents));
    if (STRIPE_CHARGE_TYPES.has(txn.type)) {
      bucket.charge_gross_cents += grossCents;
      bucket.charge_fee_cents += feeCents;
      bucket.charge_count += 1;
    }
  }
  return [...buckets.values()];
}

type MdrRecord = Record<string, unknown>;

/**
 * The endpoint refuses to reach past 10,000 records, computed from the
 * REQUESTED page size times the page number (error 10011, HTTP 400), so
 * the cap is exactly 10,000 / MDR_PAGE_SIZE pages. A 90-day window that
 * ever outgrows 10k records must be pulled as narrower ranges instead.
 */
const MDR_MAX_PAGES = 200;

/**
 * Ask for exactly what the endpoint returns. It clamps responses to 50
 * rows regardless of page[size], but it still multiplies the REQUESTED
 * size into the 10k offset ceiling: asking for 250 walled the backfill
 * at page 41 (41 x 250 > 10,000) with 160 records still unread.
 */
const MDR_PAGE_SIZE = 50;

/**
 * Per-page 429 backoff schedule; the initial request precedes delay [0].
 * The Telnyx detail-records limiter is a windowed budget: the first 90-day
 * backfill after the pagination fix burned through ~40 un-paced pages and
 * then out-waited a [0.5s..8s] ladder without recovering, so the ladder
 * has to reach the next window (error 10011).
 */
const MDR_429_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000];

/** Pause between page requests so a long pull stays under the limiter. */
const MDR_PAGE_PACING_MS = 350;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drain the Telnyx detail-records API for one record type.
 *
 * Vendor quirks shape the loop (all observed live on 2026-08-01):
 * - Responses are clamped to 50 rows per page, so a short page is NOT
 *   proof of the last page. When meta.total_pages is present it is the
 *   only trusted stop signal; the short-page break applies only when
 *   meta is absent. (The old order broke after page 1 of 53 and
 *   under-counted July 2026 spend 70x: $0.42 recorded vs $30.78 real.)
 * - The requested page[size] multiplies into a 10k offset ceiling even
 *   though it never changes the response size, so we request the real
 *   page size; see MDR_PAGE_SIZE.
 * - Long pulls trip per-account rate limits, so pages are paced and
 *   429s retry with backoff before giving up.
 *
 * A non-OK page (or blowing the page cap) throws: the caller records a
 * partial-sync error rather than silently persisting partial aggregates.
 */
export async function fetchTelnyxDetailRecords(params: {
  apiKey: string;
  recordType: "messaging" | "sip-trunking";
  range: TelnyxSyncRange;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<MdrRecord[]> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const sleepImpl = params.sleepImpl ?? defaultSleep;
  const pageSize = MDR_PAGE_SIZE;
  const headers = { Authorization: `Bearer ${params.apiKey}` };
  const all: MdrRecord[] = [];
  for (let page = 1; ; page += 1) {
    if (page > MDR_MAX_PAGES) {
      throw new Error(
        `Telnyx ${params.recordType}: exceeded ${MDR_MAX_PAGES} pages, aborting the pull`
      );
    }
    const url =
      `https://api.telnyx.com/v2/detail_records?filter[record_type]=${params.recordType}` +
      `&filter[date_range]=${params.range}&page[number]=${page}&page[size]=${pageSize}`;
    let res = await fetchImpl(url, { headers });
    for (const delayMs of MDR_429_DELAYS_MS) {
      if (res.status !== 429) break;
      await sleepImpl(delayMs);
      res = await fetchImpl(url, { headers });
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Telnyx ${params.recordType} page ${page}: HTTP ${res.status} ${body}`);
    }
    const parsed = (await res.json()) as {
      data?: MdrRecord[];
      meta?: { total_pages?: number };
    };
    const rows = parsed.data ?? [];
    all.push(...rows);
    if (rows.length === 0) break;
    const totalPages = parsed.meta?.total_pages;
    if (typeof totalPages === "number") {
      if (page >= totalPages) break;
    } else if (rows.length < pageSize) {
      break;
    }
    await sleepImpl(MDR_PAGE_PACING_MS);
  }
  return all;
}

/**
 * Aggregate raw MDRs into per-day/tenant/type/direction insert rows.
 * Records whose day falls before the window start are dropped (they were
 * captured by an earlier sync of a wider window; keeping them would
 * double-count against rows outside the delete range).
 *
 * Attribution prefers the DIRECTION-appropriate leg: an outbound record's
 * cost belongs to the sender (`cli`), an inbound record's to the receiver
 * (`cld`). Only when the preferred leg matches no tenant DID does the
 * other leg count (tenant-to-tenant traffic then lands on the paying
 * side, never on map iteration order).
 *
 * When NEITHER leg matches, the row is unattributed and carries the raw
 * preferred leg as `sender` so the Costs page can name what spent the
 * money. That leg is OUR side of the record, so it identifies a platform
 * number (the international SMS gateway), a non-numeric sender id (an RCS
 * agent, which the digits-only matcher can never match), or a genuinely
 * leaked number. Attributed rows keep `sender` null: `business_id`
 * already names the owner there.
 */
export function aggregateTelnyxRecords(params: {
  records: MdrRecord[];
  recordType: "messaging" | "sip-trunking";
  didToBusiness: Map<string, string>;
  windowStartDay: string;
}): TelnyxCostDailyInsert[] {
  const matchOwner = (num: string): string | null => {
    for (const [suffix, owner] of params.didToBusiness) {
      if (num.endsWith(suffix)) return owner;
    }
    return null;
  };

  const buckets = new Map<string, TelnyxCostDailyInsert>();
  for (const record of params.records) {
    const when = str(record.sent_at) || str(record.started_at) || str(record.created_at);
    const day = when.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < params.windowStartDay) continue;

    const direction = str(record.direction) || "unknown";
    const rawCli = str(record.cli).trim();
    const rawCld = str(record.cld).trim();
    const cli = rawCli.replace(/[^+\d]/g, "");
    const cld = rawCld.replace(/[^+\d]/g, "");
    const [preferredLeg, fallbackLeg] = direction === "inbound" ? [cld, cli] : [cli, cld];
    const businessId = matchOwner(preferredLeg) ?? matchOwner(fallbackLeg);
    // Our own leg, unnormalized: a non-numeric sender id (RCS agent) survives
    // here but is stripped to "" by the digits-only matcher above.
    const sender =
      businessId !== null
        ? null
        : senderLabel(direction === "inbound" ? [rawCld, rawCli] : [rawCli, rawCld]);

    const key = `${day}|${businessId ?? ""}|${direction}|${sender ?? ""}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        day,
        business_id: businessId,
        record_type: params.recordType,
        direction,
        record_count: 0,
        cost_micros: 0,
        carrier_fee_micros: 0,
        billed_seconds: 0,
        sender
      };
      buckets.set(key, bucket);
    }
    bucket.record_count += num(record.count) || 1;
    bucket.cost_micros += usdToMicros(num(record.cost));
    bucket.carrier_fee_micros += usdToMicros(num(record.carrier_fee));
    bucket.billed_seconds += num(record.billed_sec ?? record.billsec ?? record.billed_seconds);
  }
  return [...buckets.values()];
}

/** Months in a Hostinger billing cycle; null when the unit is unrecognized. */
export function billingCycleMonths(
  period: number | null | undefined,
  unit: string | null | undefined
): number | null {
  const n = typeof period === "number" && Number.isFinite(period) && period > 0 ? period : 1;
  if (unit === "month") return n;
  if (unit === "year") return n * 12;
  return null;
}

/** Map Hostinger billing subscriptions + VMs + tenant assignments to snapshot rows. */
export function buildHostingerSnapshot(params: {
  subscriptions: BillingSubscription[];
  virtualMachines: VirtualMachine[];
  assignments: Array<{ businessId: string; vmId: number }>;
  /** Anchor for the stale-cycle check; injectable so tests are not time bombs. */
  now?: Date;
}): HostingerVpsCostInsert[] {
  const now = params.now ?? new Date();
  const vmBySubscription = new Map<string, VirtualMachine>();
  for (const vm of params.virtualMachines) {
    if (typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
      vmBySubscription.set(vm.subscription_id, vm);
    }
  }
  const businessByVm = new Map(params.assignments.map((a) => [a.vmId, a.businessId]));

  const rows: HostingerVpsCostInsert[] = [];
  for (const sub of params.subscriptions) {
    // Only VPS (KVM) subscriptions, the billing list can carry other products.
    const planName = sub.name ?? "";
    if (!/kvm/i.test(planName)) continue;
    const vm = vmBySubscription.get(sub.id) ?? null;
    const months = billingCycleMonths(sub.billing_period, sub.billing_period_unit ?? null);
    const cycleCents = sub.renewal_price ?? sub.total_price ?? null;
    // A subscription whose declared cycle cannot explain its next billing
    // date has a stale cycle AND a stale price (see
    // cycleContradictsNextBilling), so any monthly figure derived from the
    // pair would be fiction published as an ACTUAL. Emit null instead and
    // let the margin engine fall back to its SKU estimate, which is at
    // least LABELED an estimate on every surface that renders it. For VM
    // 1806097 that swaps a $19.49 "actual" for an $11.99 estimate against a
    // true $12.99, so it is both honest and closer.
    //
    // The raw billing_period / renewal_price_cents / next_billing_at fields
    // are still stored verbatim: they are the evidence the disagreement is
    // diagnosed from, and blanking them would hide the problem instead.
    const cycleStale = cycleContradictsNextBilling(months, sub.next_billing_at, now);
    rows.push({
      subscription_id: sub.id,
      vm_id: vm?.id ?? null,
      hostname: vm?.hostname ?? null,
      plan: planName,
      status: sub.status,
      billing_period: sub.billing_period ?? null,
      billing_period_unit: sub.billing_period_unit ?? null,
      total_price_cents: sub.total_price ?? null,
      renewal_price_cents: sub.renewal_price ?? null,
      monthly_price_cents:
        months !== null && cycleCents !== null && !cycleStale
          ? Math.round(cycleCents / months)
          : null,
      is_auto_renewed: sub.is_auto_renewed ?? null,
      next_billing_at: sub.next_billing_at ?? null,
      expires_at: sub.expires_at ?? null,
      assigned_business_id: vm ? (businessByVm.get(vm.id) ?? null) : null
    });
  }
  return rows;
}

/** Run both vendor syncs, record + return the outcome. */
export async function runPlatformCostSync(
  deps: PlatformCostSyncDeps,
  options?: { telnyxRange?: TelnyxSyncRange }
): Promise<PlatformCostSyncStatus> {
  const now = deps.now ?? new Date();
  const range = options?.telnyxRange ?? "last_7_days";

  let telnyxRows = 0;
  let telnyxError: string | null = null;
  if (!deps.telnyxApiKey) {
    telnyxError = "TELNYX_API_KEY not set, Telnyx sync skipped";
  } else {
    try {
      const dids = await deps.listTenantDids();
      const didToBusiness = new Map<string, string>();
      for (const did of dids) {
        const suffix = didSuffix(did.e164);
        if (suffix) didToBusiness.set(suffix, did.businessId);
      }
      const windowStartDay = windowStartDayUtc(now, RANGE_DAYS[range]);
      const rows: TelnyxCostDailyInsert[] = [];
      for (const recordType of ["messaging", "sip-trunking"] as const) {
        const records = await fetchTelnyxDetailRecords({
          apiKey: deps.telnyxApiKey,
          recordType,
          range,
          fetchImpl: deps.fetchImpl,
          sleepImpl: deps.sleepImpl
        });
        rows.push(
          ...aggregateTelnyxRecords({ records, recordType, didToBusiness, windowStartDay })
        );
      }
      await deps.replaceTelnyxCostWindow(windowStartDay, rows);
      telnyxRows = rows.length;
    } catch (err) {
      telnyxError = err instanceof Error ? err.message : String(err);
    }
  }

  let hostingerRows = 0;
  let hostingerError: string | null = null;
  try {
    const [subscriptions, virtualMachines, assignments] = await Promise.all([
      deps.listBillingSubscriptions(),
      deps.listVirtualMachines(),
      deps.listBusinessVpsAssignments()
    ]);
    const rows = buildHostingerSnapshot({ subscriptions, virtualMachines, assignments, now });
    await deps.replaceHostingerVpsCosts(rows);
    hostingerRows = rows.length;
  } catch (err) {
    hostingerError = err instanceof Error ? err.message : String(err);
  }

  // Stripe fees: a third independently-failing side, same rule as the two
  // above, a Stripe outage must not lose the Telnyx or Hostinger pull.
  let stripeRows = 0;
  let stripeError: string | null = null;
  const stripeWindowStartMonth = windowStartMonthUtc(now, STRIPE_FEE_WINDOW_MONTHS);
  if (!deps.listStripeBalanceTransactions) {
    stripeError = "STRIPE_SECRET_KEY not set, Stripe fee sync skipped";
  } else {
    try {
      const [transactions, customerPairs] = await Promise.all([
        deps.listStripeBalanceTransactions(
          Math.floor(Date.parse(`${stripeWindowStartMonth}T00:00:00Z`) / 1000)
        ),
        deps.listStripeCustomerBusinessIds()
      ]);
      const customerToBusiness = new Map(
        customerPairs.map((pair) => [pair.stripeCustomerId, pair.businessId])
      );
      const rows = aggregateStripeFees({
        transactions,
        customerToBusiness,
        windowStartMonth: stripeWindowStartMonth
      });
      await deps.replaceStripeFeeWindow(stripeWindowStartMonth, rows);
      stripeRows = rows.length;
    } catch (err) {
      stripeError = err instanceof Error ? err.message : String(err);
    }
  }

  const status: PlatformCostSyncStatus = {
    lastSyncAt: now.toISOString(),
    ok: telnyxError === null && hostingerError === null && stripeError === null,
    telnyxRange: range,
    telnyxRows,
    telnyxError,
    hostingerRows,
    hostingerError,
    stripeMonths: STRIPE_FEE_WINDOW_MONTHS,
    stripeRows,
    stripeError
  };
  await deps.recordStatus(status);
  return status;
}
