/**
 * Per-(business_id, customer_e164) cross-channel memory.
 *
 * One row per known customer for a given business. Mirrors the
 * customer_memories table created in
 * supabase/migrations/20260507000000_customer_memories.sql.
 *
 * The shape lives in its own module so types-only imports (preamble
 * builder, recorder, customers UI) don't transitively pull in the
 * Supabase client and our server-only modules.
 */

export type CustomerMemoryChannel = "sms" | "voice" | "dashboard" | "email";

/**
 * Contact classification (the `contacts.type` column). `customer` is the default
 * for any auto-created profile; `owner`/`employee` are ALSO surfaced at read time
 * from their authoritative tables (businesses / ai_flow_team_members) by
 * resolveContactNames, so a stored value of those is just a hint. Extend this
 * list AND the DB check constraint together to add a type.
 */
export const CONTACT_TYPES = [
  "owner",
  "employee",
  "customer",
  "tester",
  "company",
  "other"
] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

/**
 * Provenance of `display_name`, independent of `type`. `manual` = the owner set
 * the name (contacts UI / set-contact / add-customer); `auto` = captured from a
 * channel (SMS/voice) or derived. A `manual` name wins over the read-time
 * owner/employee overlay in src/lib/db/contact-names.ts; an `auto` one does not.
 */
export const CONTACT_NAME_SOURCES = ["auto", "manual"] as const;
export type ContactNameSource = (typeof CONTACT_NAME_SOURCES)[number];

export type CustomerMemoryRow = {
  id: string;
  business_id: string;
  customer_e164: string;
  /** Contact classification; NOT NULL in the DB (default 'customer'). */
  type: ContactType;
  /** Provenance of display_name; NOT NULL in the DB (default 'auto'). */
  name_source: ContactNameSource;
  display_name: string | null;
  /** Owner-set email linked to this customer, so email rolls up to the profile. */
  email: string | null;
  /** LLM-generated rolling summary; null until first successful summarizer run. */
  summary_md: string | null;
  /** Owner-pinned notes. Always concatenated with summary_md in the preamble. */
  pinned_md: string | null;
  /** Interactions accumulated since the last successful summarizer run; reset to 0 on regenerate. */
  interaction_count: number;
  /** Lifetime interaction counter; never resets. Surface-only on the customers page. */
  total_interaction_count: number;
  last_interaction_at: string | null;
  last_summarized_at: string | null;
  last_channel: CustomerMemoryChannel | null;
  /** E.164 numbers merged into this profile (merge_customer_memories). */
  alias_e164s: string[];
  created_at: string;
  updated_at: string;
};
