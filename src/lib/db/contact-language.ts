import type { CustomerLanguage, LanguageSource } from "../../../shared/i18n/detect-customer-language.ts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ContactLanguageRow = {
  preferred_language: CustomerLanguage | null;
  language_source: LanguageSource | null;
};

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
    .eq("customer_e164", customerE164)
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
  const { error } = await db
    .from("contacts")
    .update({
      preferred_language: language,
      language_source: language ? "owner_set" : null
    })
    .eq("business_id", businessId)
    .eq("customer_e164", customerE164);
  if (error) throw new Error(error.message);
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
    .eq("customer_e164", customerE164);
  if (error) throw new Error(error.message);
}
