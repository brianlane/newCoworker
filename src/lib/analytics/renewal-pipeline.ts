/**
 * Renewal/expiration pipeline report — documents carrying a renewal date,
 * bucketed by how soon they renew (overdue / 30 / 60 / 90 days) with the
 * linked contact and assigned handler resolved. Generic over any record
 * type (policies, leases, contracts, memberships); the daily sweep sends
 * the reminders, this is the at-a-glance book view behind
 * /dashboard/analytics.
 *
 * business_documents is a central table (not residency-moved), so plain
 * service-role reads are correct for every tenant.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Furthest-out renewals the report shows. */
export const RENEWAL_PIPELINE_WINDOW_DAYS = 90;
/**
 * Furthest-BACK overdue renewals the report shows. A record more than a
 * year past due is stale bookkeeping, not an active pipeline item — and
 * without a floor, a pile of ancient rows could fill the ascending scan
 * cap and push genuinely upcoming renewals out of a capped report.
 */
export const RENEWAL_PIPELINE_LOOKBACK_DAYS = 365;
/** Row cap per report render; beyond it the report flags `clipped`. */
export const RENEWAL_PIPELINE_SCAN_LIMIT = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RenewalBucket = "overdue" | "next30" | "next60" | "next90";

export type RenewalPipelineRow = {
  documentId: string;
  title: string;
  category: string;
  /** YYYY-MM-DD. */
  renewalDate: string;
  /** Whole days until renewal (negative = overdue). */
  daysUntil: number;
  bucket: RenewalBucket;
  contactName: string | null;
  contactE164: string | null;
  assignedEmployee: string | null;
};

export type RenewalPipeline = {
  rows: RenewalPipelineRow[];
  counts: Record<RenewalBucket, number>;
  /** Renewals per assigned handler ("Unassigned" bucket included). */
  byAssignee: Array<{ name: string; count: number }>;
  clipped: boolean;
};

/** Bucket for a renewal `daysUntil` value (callers pre-filter to ≤ 90). */
export function renewalBucketFor(daysUntil: number): RenewalBucket {
  if (daysUntil < 0) return "overdue";
  if (daysUntil <= 30) return "next30";
  if (daysUntil <= 60) return "next60";
  return "next90";
}

export async function getRenewalPipeline(
  businessId: string,
  opts: { client?: SupabaseClient; now?: Date } = {}
): Promise<RenewalPipeline> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const horizonIso = new Date(
    now.getTime() + RENEWAL_PIPELINE_WINDOW_DAYS * DAY_MS
  ).toISOString();
  const floorIso = new Date(
    now.getTime() - RENEWAL_PIPELINE_LOOKBACK_DAYS * DAY_MS
  ).toISOString();

  // Ascending renewal_date = most-overdue first, then soonest upcoming —
  // the urgency order. The lookback floor keeps stale years-old rows from
  // filling the cap and crowding out the upcoming window.
  const { data, error } = await db
    .from("business_documents")
    .select("id, title, category, renewal_date, contact_id, assigned_employee_id")
    .eq("business_id", businessId)
    .not("renewal_date", "is", null)
    .gte("renewal_date", floorIso)
    .lte("renewal_date", horizonIso)
    .order("renewal_date", { ascending: true })
    .limit(RENEWAL_PIPELINE_SCAN_LIMIT);
  if (error) throw new Error(`getRenewalPipeline: ${error.message}`);

  type Row = {
    id: string;
    title: string;
    category: string;
    renewal_date: string;
    contact_id: string | null;
    assigned_employee_id: string | null;
  };
  const docs = ((data as Row[] | null) ?? []);

  const contactIds = [...new Set(docs.map((d) => d.contact_id).filter((v): v is string => !!v))];
  const employeeIds = [
    ...new Set(docs.map((d) => d.assigned_employee_id).filter((v): v is string => !!v))
  ];
  const contacts = new Map<string, { name: string | null; e164: string }>();
  if (contactIds.length > 0) {
    const { data: rows, error: contactErr } = await db
      .from("contacts")
      .select("id, display_name, customer_e164")
      .in("id", contactIds);
    if (contactErr) throw new Error(`getRenewalPipeline contacts: ${contactErr.message}`);
    for (const c of (rows ?? []) as Array<{
      id: string;
      display_name: string | null;
      customer_e164: string;
    }>) {
      contacts.set(c.id, { name: c.display_name?.trim() || null, e164: c.customer_e164 });
    }
  }
  const employees = new Map<string, string>();
  if (employeeIds.length > 0) {
    const { data: rows, error: memberErr } = await db
      .from("ai_flow_team_members")
      .select("id, name")
      .in("id", employeeIds);
    if (memberErr) throw new Error(`getRenewalPipeline employees: ${memberErr.message}`);
    for (const m of (rows ?? []) as Array<{ id: string; name: string }>) {
      employees.set(m.id, m.name);
    }
  }

  const counts: Record<RenewalBucket, number> = {
    overdue: 0,
    next30: 0,
    next60: 0,
    next90: 0
  };
  const assigneeCounts = new Map<string, number>();
  const rows: RenewalPipelineRow[] = [];
  for (const doc of docs) {
    const ms = Date.parse(doc.renewal_date);
    /* c8 ignore next -- renewal_date rows are DB timestamptz, always parseable */
    if (!Number.isFinite(ms)) continue;
    const daysUntil = Math.ceil((ms - now.getTime()) / DAY_MS);
    const bucket = renewalBucketFor(daysUntil);
    counts[bucket] += 1;
    const contact = doc.contact_id ? contacts.get(doc.contact_id) : undefined;
    const assignee = doc.assigned_employee_id
      ? employees.get(doc.assigned_employee_id) ?? null
      : null;
    assigneeCounts.set(assignee ?? "Unassigned", (assigneeCounts.get(assignee ?? "Unassigned") ?? 0) + 1);
    rows.push({
      documentId: doc.id,
      title: doc.title,
      category: doc.category,
      renewalDate: doc.renewal_date.slice(0, 10),
      daysUntil,
      bucket,
      contactName: contact?.name ?? null,
      contactE164: contact?.e164 ?? null,
      assignedEmployee: assignee
    });
  }

  const byAssignee = [...assigneeCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { rows, counts, byAssignee, clipped: docs.length >= RENEWAL_PIPELINE_SCAN_LIMIT };
}
