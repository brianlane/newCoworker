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

export type CustomerMemoryChannel = "sms" | "voice" | "dashboard";

export type CustomerMemoryRow = {
  id: string;
  business_id: string;
  customer_e164: string;
  display_name: string | null;
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
