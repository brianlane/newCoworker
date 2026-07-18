import type { CustomerLanguage } from "../../../shared/i18n/detect-customer-language.ts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BusinessCustomerLanguages = {
  defaultLanguage: CustomerLanguage;
  supported: CustomerLanguage[];
};

const DEFAULTS: BusinessCustomerLanguages = {
  defaultLanguage: "en",
  supported: ["en", "es"]
};

/**
 * Per-tenant customer-language settings. `supported: ["en"]` is the escape
 * hatch that disables Spanish following on every AI channel. Falls back to
 * the platform defaults (en default, en+es supported) on any read failure —
 * language-following is additive, so failing open is safe.
 */
export async function getBusinessCustomerLanguages(
  businessId: string,
  client?: SupabaseClient
): Promise<BusinessCustomerLanguages> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("businesses")
      .select("default_customer_language, supported_customer_languages")
      .eq("id", businessId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as {
      default_customer_language?: string | null;
      supported_customer_languages?: string[] | null;
    } | null;
    const defaultLanguage: CustomerLanguage =
      row?.default_customer_language === "es" ? "es" : "en";
    const supported = Array.isArray(row?.supported_customer_languages)
      ? row.supported_customer_languages.filter(
          (l): l is CustomerLanguage => l === "en" || l === "es"
        )
      : [];
    return {
      defaultLanguage,
      supported: supported.length > 0 ? supported : DEFAULTS.supported
    };
  } catch (err) {
    logger.warn("getBusinessCustomerLanguages failed; using defaults", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return DEFAULTS;
  }
}
