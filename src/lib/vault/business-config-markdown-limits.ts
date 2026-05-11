import { WEBSITE_INGEST_MAX_SUMMARY_CHARS } from "@/lib/website-ingest";

/** Hard caps for owner-edited vault markdown (`business_configs`). */
export const BUSINESS_CONFIG_SOUL_MD_MAX_CHARS = 32_000;
export const BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS = 32_000;
/** Matches `owner-append-business-memory` — keeps Rowboat prefill bounded. */
export const BUSINESS_CONFIG_MEMORY_MD_MAX_CHARS = 14_000;
export const BUSINESS_CONFIG_WEBSITE_MD_MAX_CHARS = WEBSITE_INGEST_MAX_SUMMARY_CHARS;
