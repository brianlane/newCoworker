/**
 * Client-safe constants for the bulk contact actions. Kept apart from
 * bulk.ts because that module pulls in the Supabase service client, while
 * the customers page needs the cap in the BROWSER to chunk big selections.
 */

/** Hard per-request contact cap; the UI applies larger selections in chunks. */
export const BULK_MAX_CONTACTS = 200;
