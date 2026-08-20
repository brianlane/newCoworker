/**
 * Supabase access for deals. Service-role only; authorization is the API
 * route's job via requireBusinessRole, same trust model as the segments /
 * documents db modules. Status-transition legality lives in ./core; this
 * module reads the current row, asks core whether the move is legal, and
 * writes the outcome (including the won_at/lost_at stamps).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveContactNames } from "@/lib/db/contact-names";
import {
  canTransitionDealStatus,
  dealStatusStamps,
  type Deal,
  type DealCreateInput,
  type DealPatchInput,
  type DealStatus
} from "./core";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Explicit list cap: PostgREST silently truncates un-limited selects at
 * 1000 rows, so the cap is stated where the reader can see it.
 */
export const DEALS_LIST_LIMIT = 500;

/** Typed failure the API routes map onto 4xx responses. */
export class DealError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid" | "transition",
    message: string
  ) {
    super(message);
    this.name = "DealError";
  }
}

type DealRow = {
  id: string;
  business_id: string;
  contact_id: string | null;
  title: string;
  value_cents: number | null;
  currency: string;
  commission_bps: number | null;
  expected_close_date: string | null;
  status: DealStatus;
  won_at: string | null;
  lost_at: string | null;
  created_at: string;
  updated_at: string;
};

// One literal (never concatenated): supabase-js parses the select string at
// the type level, and a widened `string` degrades every row to a parse error.
const DEAL_COLUMNS =
  "id, business_id, contact_id, title, value_cents, currency, commission_bps, expected_close_date, status, won_at, lost_at, created_at, updated_at";

function toDeal(row: DealRow): Deal {
  return {
    id: row.id,
    businessId: row.business_id,
    contactId: row.contact_id,
    title: row.title,
    valueCents: row.value_cents,
    currency: row.currency,
    commissionBps: row.commission_bps,
    expectedCloseDate: row.expected_close_date,
    status: row.status,
    wonAt: row.won_at,
    lostAt: row.lost_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Every deal for a business, newest first (the board buckets client-side). */
export async function listDeals(businessId: string, client?: SupabaseClient): Promise<Deal[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("deals")
    .select(DEAL_COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(DEALS_LIST_LIMIT);
  if (error) throw new Error(`listDeals: ${error.message}`);
  return ((data ?? []) as DealRow[]).map(toDeal);
}

/** A deal plus the display facts the board card needs about its contact. */
export type DealWithContact = Deal & {
  /** The linked contact's key (E.164 or an email: key); null when unlinked. */
  contactE164: string | null;
  /** Resolved display name, falling back to the stored label then the key. */
  contactName: string | null;
};

/**
 * The board read: deals plus each linked contact's key and resolved name
 * (same resolver precedence as the tasks board). Name-resolution blips
 * degrade to the stored display label rather than failing the board.
 */
export async function listDealsWithContacts(
  businessId: string,
  client?: SupabaseClient
): Promise<DealWithContact[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const deals = await listDeals(businessId, db);
  const contactIds = [...new Set(deals.map((d) => d.contactId).filter((id): id is string => !!id))];

  const contacts = new Map<string, { e164: string; displayName: string | null }>();
  if (contactIds.length > 0) {
    const { data, error } = await db
      .from("contacts")
      .select("id, customer_e164, display_name")
      .eq("business_id", businessId)
      .in("id", contactIds);
    if (error) throw new Error(`listDealsWithContacts: contacts: ${error.message}`);
    for (const row of (data ?? []) as {
      id: string;
      customer_e164: string;
      display_name: string | null;
    }[]) {
      contacts.set(row.id, { e164: row.customer_e164, displayName: row.display_name });
    }
  }

  const names = await resolveContactNames(
    businessId,
    [...contacts.values()].map((c) => c.e164),
    db
  ).catch(() => new Map<string, { name: string }>());

  return deals.map((deal) => {
    const contact = deal.contactId ? contacts.get(deal.contactId) ?? null : null;
    return {
      ...deal,
      contactE164: contact?.e164 ?? null,
      contactName: contact
        ? names.get(contact.e164)?.name ?? contact.displayName ?? contact.e164
        : null
    };
  });
}

/**
 * Insert a new deal. A deal created straight into won/lost (backfilling
 * closed business) gets its terminal stamp at creation.
 */
export async function createDeal(
  businessId: string,
  input: DealCreateInput,
  createdBy: string | null,
  client?: SupabaseClient
): Promise<Deal> {
  const db = client ?? (await createSupabaseServiceClient());
  const status: DealStatus = input.status ?? "open";
  const { data, error } = await db
    .from("deals")
    .insert({
      business_id: businessId,
      contact_id: input.contactId ?? null,
      title: input.title,
      value_cents: input.valueCents ?? null,
      currency: input.currency ?? "USD",
      commission_bps: input.commissionBps ?? null,
      expected_close_date: input.expectedCloseDate ?? null,
      status,
      ...dealStatusStamps(status, new Date().toISOString()),
      created_by: createdBy
    })
    .select(DEAL_COLUMNS)
    .single();
  if (error || !data) {
    // A bogus contactId (23503) is caller input, not an outage.
    if ((error as { code?: string } | null)?.code === "23503") {
      throw new DealError("invalid", "That contact does not exist.");
    }
    throw new Error(`createDeal: ${error?.message ?? "insert returned no row"}`);
  }
  return toDeal(data as DealRow);
}

/**
 * Patch a deal. A status change is validated against the funnel rules and
 * carries its won_at/lost_at stamps; a patch that leaves status untouched
 * never disturbs the stamps.
 */
export async function updateDeal(
  businessId: string,
  dealId: string,
  patch: DealPatchInput,
  client?: SupabaseClient
): Promise<Deal> {
  const db = client ?? (await createSupabaseServiceClient());

  const { data: currentRow, error: readError } = await db
    .from("deals")
    .select(DEAL_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", dealId)
    .maybeSingle();
  if (readError) throw new Error(`updateDeal: read: ${readError.message}`);
  if (!currentRow) throw new DealError("not_found", "Deal not found.");
  const current = toDeal(currentRow as DealRow);

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.contactId !== undefined ? { contact_id: patch.contactId } : {}),
    ...(patch.valueCents !== undefined ? { value_cents: patch.valueCents } : {}),
    ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
    ...(patch.commissionBps !== undefined ? { commission_bps: patch.commissionBps } : {}),
    ...(patch.expectedCloseDate !== undefined
      ? { expected_close_date: patch.expectedCloseDate }
      : {})
  };
  if (patch.status !== undefined && patch.status !== current.status) {
    if (!canTransitionDealStatus(current.status, patch.status)) {
      throw new DealError(
        "transition",
        `A ${current.status.replace("_", " ")} deal cannot move straight to ` +
          `${patch.status.replace("_", " ")}; reopen it first.`
      );
    }
    updates.status = patch.status;
    Object.assign(updates, dealStatusStamps(patch.status, new Date().toISOString()));
  }

  const { data, error } = await db
    .from("deals")
    .update(updates)
    .eq("business_id", businessId)
    .eq("id", dealId)
    .select(DEAL_COLUMNS)
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23503") {
      throw new DealError("invalid", "That contact does not exist.");
    }
    throw new Error(`updateDeal: ${error.message}`);
  }
  // A no-match update returns no error and no row (PostgREST), so the
  // deleted-between-read-and-write race still reads as not found.
  if (!data) throw new DealError("not_found", "Deal not found.");
  return toDeal(data as DealRow);
}

/** Delete a deal (history record only; the contact is untouched). */
export async function deleteDeal(
  businessId: string,
  dealId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("deals")
    .delete()
    .eq("business_id", businessId)
    .eq("id", dealId)
    .select("id");
  if (error) throw new Error(`deleteDeal: ${error.message}`);
  if ((data ?? []).length === 0) throw new DealError("not_found", "Deal not found.");
}
