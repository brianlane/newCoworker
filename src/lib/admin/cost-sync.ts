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
