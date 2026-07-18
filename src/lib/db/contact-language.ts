import type { CustomerLanguage, LanguageSource } from "../../../shared/i18n/detect-customer-language.ts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { PG_UNIQUE_VIOLATION } from "@/lib/customer-memory/db";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ContactLanguageRow = {
  preferred_language: CustomerLanguage | null;
  language_source: LanguageSource | null;
};

/**
 * Alias-aware contact match: a number merged into another profile
 * (alias_e164s) must resolve to the surviving row, mirroring contact-memory
 * lookups elsewhere.
 */
function contactMatchFilter(customerE164: string): string {
  return `customer_e164.eq.${customerE164},alias_e164s.cs.{${customerE164}}`;
}

export async function getContactLanguage(
  businessId: string,
  customerE164: string,
  client?: SupabaseClient
): Promise<ContactLanguageRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("contacts")
    .select("preferred_language, language_source")
    .eq("business_id", businessId)
    .or(contactMatchFilter(customerE164))
    .maybeSingle();
  if (error) throw new Error(error.message);
  return {
    preferred_language: (data as ContactLanguageRow | null)?.preferred_language ?? null,
    language_source: (data as ContactLanguageRow | null)?.language_source ?? null
  };
}

export async function setContactLanguageOwnerOverride(
  businessId: string,
  customerE164: string,
  language: CustomerLanguage | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const patch = {
    preferred_language: language,
    language_source: language ? ("owner_set" as const) : null
  };
  // Update-then-insert (mirrors setContactOverride): an SMS thread can exist
  // before any contacts row, and a silent zero-row UPDATE would report
  // success while storing nothing.
  const { data: updated, error } = await db
    .from("contacts")
    .update(patch)
    .eq("business_id", businessId)
    .or(contactMatchFilter(customerE164))
    .select("id");
  if (error) throw new Error(error.message);
  if ((updated && updated.length > 0) || !language) return;

  const { error: insErr } = await db.from("contacts").insert({
    business_id: businessId,
    customer_e164: customerE164,
    ...patch
  });
  if (!insErr) return;
  if (insErr.code !== PG_UNIQUE_VIOLATION) throw new Error(insErr.message);
  // Race: a concurrent writer created the row between update and insert.
  const { error: raceErr } = await db
    .from("contacts")
    .update(patch)
    .eq("business_id", businessId)
    .or(contactMatchFilter(customerE164));
  if (raceErr) throw new Error(raceErr.message);
}

export async function persistDetectedContactLanguage(
  businessId: string,
  customerE164: string,
  language: CustomerLanguage,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const existing = await getContactLanguage(businessId, customerE164, db);
  if (existing.language_source === "owner_set") return;

  const { error } = await db
    .from("contacts")
    .update({
      preferred_language: language,
      language_source: "detected"
    })
    .eq("business_id", businessId)
    .or(contactMatchFilter(customerE164));
  if (error) throw new Error(error.message);
}
