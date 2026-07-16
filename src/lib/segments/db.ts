/**
 * Supabase access for contact segments (Smart Lists). Service-role only;
 * authorization is the API route's job via requireBusinessRole — same trust
 * model as the pipelines/customers db modules.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  MAX_SEGMENTS_PER_BUSINESS,
  MAX_SEGMENT_NAME_LENGTH,
  segmentFiltersSchema,
  type ContactSegment,
  type SegmentFilters
} from "./core";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Typed failure the API routes map onto 4xx responses. */
export class SegmentError extends Error {
  constructor(
    public readonly code: "not_found" | "limit" | "duplicate" | "invalid",
    message: string
  ) {
    super(message);
    this.name = "SegmentError";
  }
}

type SegmentRow = {
  id: string;
  business_id: string;
  name: string;
  filters: unknown;
  position: number;
};

const SEGMENT_COLUMNS = "id, business_id, name, filters, position";

/**
 * Stored filters re-validated on read: a row predating a filter-schema
 * change (or hand-edited) degrades to "all contacts" instead of throwing
 * the whole list away.
 */
function toSegment(row: SegmentRow): ContactSegment {
  const parsed = segmentFiltersSchema.safeParse(row.filters);
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    filters: parsed.success ? parsed.data : {},
    position: row.position
  };
}

function cleanSegmentName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > MAX_SEGMENT_NAME_LENGTH) {
    throw new SegmentError(
      "invalid",
      `List names must be 1–${MAX_SEGMENT_NAME_LENGTH} characters.`
    );
  }
  return name;
}

/** Every saved segment for a business, board order. */
export async function listContactSegments(
  businessId: string,
  client?: SupabaseClient
): Promise<ContactSegment[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("contact_segments")
    .select(SEGMENT_COLUMNS)
    .eq("business_id", businessId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listContactSegments: ${error.message}`);
  return ((data ?? []) as SegmentRow[]).map(toSegment);
}

/** Save a new segment at the end of the chip row. */
export async function createContactSegment(
  businessId: string,
  name: string,
  filters: SegmentFilters,
  client?: SupabaseClient
): Promise<ContactSegment> {
  const db = client ?? (await createSupabaseServiceClient());
  const cleanName = cleanSegmentName(name);

  const { data: existing, error: countErr } = await db
    .from("contact_segments")
    .select("id")
    .eq("business_id", businessId);
  if (countErr) throw new Error(`createContactSegment: count: ${countErr.message}`);
  const count = (existing ?? []).length;
  if (count >= MAX_SEGMENTS_PER_BUSINESS) {
    throw new SegmentError(
      "limit",
      `A business can have at most ${MAX_SEGMENTS_PER_BUSINESS} smart lists.`
    );
  }

  const { data, error } = await db
    .from("contact_segments")
    .insert({ business_id: businessId, name: cleanName, filters, position: count })
    .select(SEGMENT_COLUMNS)
    .single();
  if (error || !data) {
    // The unique (business_id, lower(name)) index rejects duplicates (23505).
    if ((error as { code?: string } | null)?.code === "23505") {
      throw new SegmentError("duplicate", `A list named "${cleanName}" already exists.`);
    }
    throw new Error(`createContactSegment: ${error?.message ?? "insert returned no row"}`);
  }
  return toSegment(data as SegmentRow);
}

/** Rename and/or replace a segment's filters. */
export async function updateContactSegment(
  businessId: string,
  segmentId: string,
  patch: { name?: string; filters?: SegmentFilters },
  client?: SupabaseClient
): Promise<ContactSegment> {
  const db = client ?? (await createSupabaseServiceClient());
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    ...(patch.name !== undefined ? { name: cleanSegmentName(patch.name) } : {}),
    ...(patch.filters !== undefined ? { filters: patch.filters } : {})
  };

  const { data, error } = await db
    .from("contact_segments")
    .update(updates)
    .eq("business_id", businessId)
    .eq("id", segmentId)
    .select(SEGMENT_COLUMNS)
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new SegmentError("duplicate", "A list with that name already exists.");
    }
    throw new Error(`updateContactSegment: ${error.message}`);
  }
  if (!data) throw new SegmentError("not_found", "Smart list not found.");
  return toSegment(data as SegmentRow);
}

/** Delete a segment (a saved view only — contacts are untouched). */
export async function deleteContactSegment(
  businessId: string,
  segmentId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("contact_segments")
    .delete()
    .eq("business_id", businessId)
    .eq("id", segmentId)
    .select("id");
  if (error) throw new Error(`deleteContactSegment: ${error.message}`);
  if ((data ?? []).length === 0) {
    throw new SegmentError("not_found", "Smart list not found.");
  }
}
