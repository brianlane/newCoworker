/**
 * Platform cost sync — the productized version of the one-shot canvas pull
 * (debug/pull-cost-data.ts), run daily by cron and on demand from the admin
 * Costs page:
 *
 *   1. Telnyx `/v2/detail_records` (invoice-grade MDRs: our real per-unit
 *      rate + 10DLC carrier fees) aggregated per UTC day / tenant /
 *      record type / direction into `telnyx_cost_daily`. Records are
 *      attributed to a tenant when the MDR's cli/cld matches one of the
 *      tenant's DIDs (messaging from-number + routed voice DIDs);
 *      unmatched records land with business_id NULL — the costs page
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
 * implementations. Nothing here bills anyone — operator telemetry only.
 */

import type { BillingSubscription, VirtualMachine } from "@/lib/hostinger/client";
import type { HostingerVpsCostInsert, TelnyxCostDailyInsert } from "@/lib/db/platform-costs";

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
};

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
    hostingerError: typeof r.hostingerError === "string" ? r.hostingerError : null
  };
}

export type TenantDid = { businessId: string; e164: string };

export type PlatformCostSyncDeps = {
  /** Null/empty skips the Telnyx side with a recorded error (mirrors pull-cost-data). */
  telnyxApiKey: string | null;
  fetchImpl?: typeof fetch;
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

/** UTC YYYY-MM-DD for "today minus `days`". */
export function windowStartDayUtc(now: Date, days: number): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

type MdrRecord = Record<string, unknown>;

/**
 * Drain the Telnyx detail-records API for one record type. Pages of 250,
 * same stopping rules as the canvas pull: keep paging while pages come
 * back full; trust meta.total_pages only when present (a missing value
 * must not stop after a full first page). A non-OK page throws — the
 * caller records a partial-sync error rather than silently persisting
 * partial aggregates.
 */
export async function fetchTelnyxDetailRecords(params: {
  apiKey: string;
  recordType: "messaging" | "sip-trunking";
  range: TelnyxSyncRange;
  fetchImpl?: typeof fetch;
}): Promise<MdrRecord[]> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const pageSize = 250;
  const all: MdrRecord[] = [];
  for (let page = 1; ; page += 1) {
    const url =
      `https://api.telnyx.com/v2/detail_records?filter[record_type]=${params.recordType}` +
      `&filter[date_range]=${params.range}&page[number]=${page}&page[size]=${pageSize}`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${params.apiKey}` }
    });
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
    const totalPages = parsed.meta?.total_pages;
    if (rows.length < pageSize) break;
    if (typeof totalPages === "number" && page >= totalPages) break;
  }
  return all;
}

/**
 * Aggregate raw MDRs into per-day/tenant/type/direction insert rows.
 * Records whose day falls before the window start are dropped (they were
 * captured by an earlier sync of a wider window; keeping them would
 * double-count against rows outside the delete range).
 */
export function aggregateTelnyxRecords(params: {
  records: MdrRecord[];
  recordType: "messaging" | "sip-trunking";
  didToBusiness: Map<string, string>;
  windowStartDay: string;
}): TelnyxCostDailyInsert[] {
  const buckets = new Map<string, TelnyxCostDailyInsert>();
  for (const record of params.records) {
    const when = str(record.sent_at) || str(record.started_at) || str(record.created_at);
    const day = when.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < params.windowStartDay) continue;

    const direction = str(record.direction) || "unknown";
    const cli = str(record.cli).replace(/[^+\d]/g, "");
    const cld = str(record.cld).replace(/[^+\d]/g, "");
    let businessId: string | null = null;
    for (const [suffix, owner] of params.didToBusiness) {
      if (cli.endsWith(suffix) || cld.endsWith(suffix)) {
        businessId = owner;
        break;
      }
    }

    const key = `${day}|${businessId ?? ""}|${direction}`;
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
        billed_seconds: 0
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
}): HostingerVpsCostInsert[] {
  const vmBySubscription = new Map<string, VirtualMachine>();
  for (const vm of params.virtualMachines) {
    if (typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
      vmBySubscription.set(vm.subscription_id, vm);
    }
  }
  const businessByVm = new Map(params.assignments.map((a) => [a.vmId, a.businessId]));

  const rows: HostingerVpsCostInsert[] = [];
  for (const sub of params.subscriptions) {
    // Only VPS (KVM) subscriptions — the billing list can carry other products.
    const planName = sub.name ?? "";
    if (!/kvm/i.test(planName)) continue;
    const vm = vmBySubscription.get(sub.id) ?? null;
    const months = billingCycleMonths(sub.billing_period, sub.billing_period_unit ?? null);
    const cycleCents = sub.renewal_price ?? sub.total_price ?? null;
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
        months !== null && cycleCents !== null ? Math.round(cycleCents / months) : null,
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
    telnyxError = "TELNYX_API_KEY not set — Telnyx sync skipped";
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
          fetchImpl: deps.fetchImpl
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
    const rows = buildHostingerSnapshot({ subscriptions, virtualMachines, assignments });
    await deps.replaceHostingerVpsCosts(rows);
    hostingerRows = rows.length;
  } catch (err) {
    hostingerError = err instanceof Error ? err.message : String(err);
  }

  const status: PlatformCostSyncStatus = {
    lastSyncAt: now.toISOString(),
    ok: telnyxError === null && hostingerError === null,
    telnyxRange: range,
    telnyxRows,
    telnyxError,
    hostingerRows,
    hostingerError
  };
  await deps.recordStatus(status);
  return status;
}
