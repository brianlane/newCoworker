/** Hard caps for owner-edited vault markdown (`business_configs`). */
export const BUSINESS_CONFIG_SOUL_MD_MAX_CHARS = 32_000;
export const BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS = 32_000;
/** Matches `owner-append-business-memory` — keeps Rowboat prefill bounded. */
export const BUSINESS_CONFIG_MEMORY_MD_MAX_CHARS = 14_000;
/**
 * Must stay equal to `WEBSITE_INGEST_MAX_SUMMARY_CHARS` in `@/lib/website-ingest`.
 * Do not import that module here — it pulls Node-only code (`node:dns`) and this
 * file is used from client components (`MemoryEditor`, `SoulEditor`).
 */
export const BUSINESS_CONFIG_WEBSITE_MD_MAX_CHARS = 8_000;
