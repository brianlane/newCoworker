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

export type CustomerMemoryChannel = "sms" | "voice" | "dashboard" | "email" | "webchat" | "messenger";

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

/**
 * Per-contact default-reply behavior for inbound SMS (contacts.sms_reply_mode).
 * `auto` = the Coworker replies (default). `suppress` = no default reply, but
 * AiFlows, logging, interaction counters and manual sends are unaffected.
 * `forward_owner` = no default reply; the text is forwarded to the owner's
 * cell ("What would you like me to say?") and the owner's reply is relayed.
 * Must stay in lockstep with supabase/functions/_shared/contact_reply_mode.ts
 * and the contacts_sms_reply_mode_chk DB constraint (lockstep test in
 * tests/contact-reply-mode.test.ts).
 */
export const SMS_REPLY_MODES = ["auto", "suppress", "forward_owner"] as const;
export type SmsReplyMode = (typeof SMS_REPLY_MODES)[number];

export type CustomerMemoryRow = {
  id: string;
  business_id: string;
  customer_e164: string;
  /** Contact classification; NOT NULL in the DB (default 'customer'). */
  type: ContactType;
  /** Provenance of display_name; NOT NULL in the DB (default 'auto'). */
  name_source: ContactNameSource;
  /** Default-reply behavior for this contact's inbound SMS; NOT NULL (default 'auto'). */
  sms_reply_mode: SmsReplyMode;
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
  /** Free-form owner-defined labels (max MAX_CONTACT_TAGS). Never null (DB default {}). */
  tags: string[];
  /** Roster member (ai_flow_team_members.id) who owns this contact; null = unowned. */
  owner_employee_id: string | null;
  /** Optional birth date ("YYYY-MM-DD"); month/day fire the AiFlow birthday trigger. */
  birthday: string | null;
  created_at: string;
  updated_at: string;
};

/** Tag caps (mirrored by the contacts_tags_cap_chk DB constraint). */
export const MAX_CONTACT_TAGS = 25;
export const MAX_CONTACT_TAG_LENGTH = 40;

/**
 * Normalize a tag list the way every write path must: trim, drop empties,
 * clamp length, de-dup case-insensitively (first spelling wins), cap count.
 */
export function normalizeContactTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const tag = t.trim().slice(0, MAX_CONTACT_TAG_LENGTH);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_CONTACT_TAGS) break;
  }
  return out;
}
