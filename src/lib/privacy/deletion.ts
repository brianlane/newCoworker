/**
 * End-user ("data subject") erasure tooling (security review G6).
 *
 * Deletes one person's data across the tenant's content tables, keyed by
 * their phone number (E.164) and/or email: the two identifiers the
 * platform ever captures for a tenant's customer. Admin-only: the admin
 * route drives this on a verified privacy request (PIPEDA/Law 25 erasure,
 * CCPA delete, etc.) and logs an audit row with a FINGERPRINT of the
 * identifier (never the identifier itself: the audit trail must not
 * re-create the PII it documents removing).
 *
 * Residency interplay:
 *   * Central deletes journal normally (they are real content deletes), so
 *     a dual/vps box receives them as replicated 'delete' ops.
 *   * A vps-mode box also holds history central already purged, which the
 *     journal can't reach, so for dual/vps tenants every table is ALSO
 *     deleted directly on the box through the data API. The overlap with
 *     journaled deletes is idempotent.
 *   * An unreachable dual/vps box fails the request loudly: reporting
 *     "deleted" while a box copy survives would be a false compliance
 *     attestation. Central deletes that already ran stay deleted; re-run
 *     after the box is back to converge.
 */

import { createHash } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { DataApiClient } from "@/lib/residency/client";
import type { DataApiFilter } from "@/lib/residency/contract";
import type { ResidencyMovedTable } from "@/lib/residency/tables";
import { residencyModeFor } from "@/lib/residency/read";
import { syncVaultToVps, type VaultSyncResult } from "@/lib/vps/sync-vault";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export class EndUserDeletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndUserDeletionError";
  }
}

export type EndUserIdentifier = {
  /** E.164 phone number of the person to erase (e.g. +15551234567). */
  e164?: string;
  /** Email address of the person to erase. */
  email?: string;
};

export type DeletionTableResult = {
  table: string;
  central: number;
  /** Rows deleted on the tenant box; null when the tenant has no box copy. */
  box: number | null;
};

export type DeletionResult = {
  businessId: string;
  /** sha256 of the normalized identifiers: safe for audit logs. */
  identifierFingerprint: string;
  tables: DeletionTableResult[];
};

export type DeletionDeps = {
  client?: SupabaseClient;
  /** Injectable data-api client factory (tests). */
  dataApiFor?: (businessId: string) => Pick<DataApiClient, "select" | "delete">;
  /**
   * Injectable memory-graph box re-projection (tests). The box serves the
   * graph from files (entity notes + graph.jsonl compiled into graph.db)
   * that only a vault sync rewrites, so graph deletions must trigger one.
   */
  syncVault?: (businessId: string) => Promise<VaultSyncResult>;
};

const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Normalize + validate the identifier pair; at least one required. */
export function normalizeEndUserIdentifier(ident: EndUserIdentifier): {
  e164: string | null;
  email: string | null;
} {
  const e164 = ident.e164?.trim() || null;
  const email = ident.email?.trim().toLowerCase() || null;
  if (!e164 && !email) {
    throw new EndUserDeletionError("Provide an E.164 phone number and/or an email address");
  }
  if (e164 && !E164_RE.test(e164)) {
    throw new EndUserDeletionError(`Not a valid E.164 number: ${e164}`);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new EndUserDeletionError("Not a valid email address");
  }
  return { e164, email };
}

/** Audit-safe fingerprint of the normalized identifiers. */
export function fingerprintIdentifier(e164: string | null, email: string | null): string {
  return createHash("sha256")
    .update(`${e164 ?? ""}|${email ?? ""}`)
    .digest("hex");
}

/**
 * Escape LIKE/ILIKE metacharacters so an identifier is matched as a LITERAL
 * (case-insensitively), never as a pattern. Without this, an email whose
 * local part contains `_` or `%` (both legal in email addresses) would
 * wildcard-match and erase OTHER people's rows: the exact opposite of a
 * scoped privacy deletion.
 */
export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/* c8 ignore next 2 -- production default; tests inject dataApiFor */
const defaultDataApiFor = (businessId: string): Pick<DataApiClient, "select" | "delete"> =>
  new DataApiClient(businessId);

/* c8 ignore next 2 -- production default; tests inject syncVault */
const defaultSyncVault = (businessId: string): Promise<VaultSyncResult> =>
  syncVaultToVps(businessId);

/**
 * Erase one end user's rows across the tenant's content tables (central +
 * box). Returns per-table counts for the audit log.
 */
export async function deleteEndUserData(
  businessId: string,
  ident: EndUserIdentifier,
  deps: DeletionDeps = {}
): Promise<DeletionResult> {
  const { e164, email } = normalizeEndUserIdentifier(ident);
  // ILIKE gives the case-insensitivity; escaping keeps the match LITERAL.
  const emailPattern = email === null ? null : escapeLikeLiteral(email);
  const db = deps.client ?? (await createSupabaseServiceClient());
  const dataApiFor = deps.dataApiFor ?? defaultDataApiFor;
  const syncVault = deps.syncVault ?? defaultSyncVault;

  const mode = await residencyModeFor(businessId, db);
  const boxed = mode === "dual" || mode === "vps";
  const api = boxed ? dataApiFor(businessId) : null;

  const results: DeletionTableResult[] = [];

  const boxDelete = async (
    table: ResidencyMovedTable,
    filters: DataApiFilter[]
  ): Promise<number> => {
    /* c8 ignore next -- callers gate on `api` before invoking */
    if (!api) return 0;
    const res = await api.delete({
      table,
      filters: [{ column: "business_id", op: "eq", value: businessId }, ...filters],
      returning: true
    });
    if (!res.ok) {
      throw new EndUserDeletionError(`box delete on ${table} failed: ${res.message}`);
    }
    return res.rows.length;
  };

  const count = (data: unknown): number => (Array.isArray(data) ? data.length : 0);

  // ── contacts (directory + AI memory) ───────────────────────────────────
  // Also the owner-set display names and emails that used to live in
  // contact_overrides: 20260704000000_contacts_unify.sql folded that table
  // into this one and dropped it, so this block is their only erasure path.
  // Matches customer_e164, alias_e164s membership, or email. Contacts are
  // kept central in every residency mode, so the journaled central delete
  // reaches the box copy; a direct box delete on the primary identifiers
  // still runs for vps tenants as belt-and-braces.
  // Every number linked to this person (primary + merge aliases), captured
  // BEFORE the contact rows are deleted: ai_reply_reasoning below is keyed
  // by whichever number the person texted from, which may be an alias, and
  // an EMAIL-ONLY request still identifies phone-keyed reasoning through the
  // contact row's numbers. The capture is symmetric: a PHONE-ONLY request
  // also collects the contact rows' email addresses, so email-keyed stores
  // (email_log, campaign recipients, webchat visitor emails, attributed
  // graph facts) are reachable from either axis. One hop only, matching the
  // number capture: collected emails feed the downstream matchers, they do
  // not re-scan contacts for further twins.
  const linkedNumbers = new Set<string>(e164 ? [e164] : []);
  const linkedEmails = new Set<string>(email ? [email] : []);
  const collectLinkedIdentifiers = (rows: unknown): void => {
    for (const row of (Array.isArray(rows) ? rows : []) as Array<{
      customer_e164: string;
      alias_e164s?: unknown;
      email?: unknown;
    }>) {
      linkedNumbers.add(row.customer_e164);
      for (const alias of Array.isArray(row.alias_e164s) ? row.alias_e164s : []) {
        if (typeof alias === "string" && alias) linkedNumbers.add(alias);
      }
      if (typeof row.email === "string" && row.email.trim()) {
        linkedEmails.add(row.email.trim().toLowerCase());
      }
    }
  };
  {
    let central = 0;
    if (e164) {
      const { data: linkedRows, error: linkedErr } = await db
        .from("contacts")
        .select("customer_e164, alias_e164s, email")
        .eq("business_id", businessId)
        .or(`customer_e164.eq.${e164},alias_e164s.cs.{${e164}}`);
      if (linkedErr) {
        throw new EndUserDeletionError(`contacts (linked-number scan): ${linkedErr.message}`);
      }
      collectLinkedIdentifiers(linkedRows);
      const [primary, alias] = await Promise.all([
        db
          .from("contacts")
          .delete()
          .eq("business_id", businessId)
          .eq("customer_e164", e164)
          .select("id"),
        db
          .from("contacts")
          .delete()
          .eq("business_id", businessId)
          .contains("alias_e164s", [e164])
          .select("id")
      ]);
      if (primary.error) {
        throw new EndUserDeletionError(`contacts (e164): ${primary.error.message}`);
      }
      if (alias.error) {
        throw new EndUserDeletionError(`contacts (alias): ${alias.error.message}`);
      }
      central += count(primary.data) + count(alias.data);
    }
    if (email) {
      // Same pre-delete capture on the email axis: an email-only erasure
      // must still find the person's phone numbers for the phone-keyed
      // reasoning delete below.
      const { data: emailLinked, error: emailLinkedErr } = await db
        .from("contacts")
        .select("customer_e164, alias_e164s, email")
        .eq("business_id", businessId)
        .ilike("email", emailPattern!);
      if (emailLinkedErr) {
        throw new EndUserDeletionError(
          `contacts (linked-number scan, email): ${emailLinkedErr.message}`
        );
      }
      collectLinkedIdentifiers(emailLinked);
      const { data, error } = await db
        .from("contacts")
        .delete()
        .eq("business_id", businessId)
        .ilike("email", emailPattern!)
        .select("id");
      if (error) throw new EndUserDeletionError(`contacts (email): ${error.message}`);
      central += count(data);
    }
    let box: number | null = null;
    if (api) {
      box = 0;
      if (e164) {
        box += await boxDelete("contacts", [{ column: "customer_e164", op: "eq", value: e164 }]);
        // Alias matches: the data-api filter grammar has no array-contains
        // op, and the journaled central delete can't cover a RETRY (central
        // row already gone, box copy still keyed by alias). Page the box's
        // contacts and match alias_e164s client-side: collect ids first,
        // delete after, so deletions never disturb the pagination.
        const aliasIds: string[] = [];
        const PAGE = 500;
        for (let offset = 0; ; offset += PAGE) {
          const page = await api.select({
            table: "contacts",
            columns: ["id", "alias_e164s"],
            filters: [{ column: "business_id", op: "eq", value: businessId }],
            order: [{ column: "id", ascending: true }],
            limit: PAGE,
            offset
          });
          if (!page.ok) {
            throw new EndUserDeletionError(`box select on contacts failed: ${page.message}`);
          }
          for (const row of page.rows as Array<{ id: unknown; alias_e164s?: unknown }>) {
            const aliases = Array.isArray(row.alias_e164s) ? row.alias_e164s : [];
            if (aliases.includes(e164)) aliasIds.push(String(row.id));
          }
          if (page.rows.length < PAGE) break;
        }
        if (aliasIds.length > 0) {
          box += await boxDelete("contacts", [{ column: "id", op: "in", value: aliasIds }]);
        }
      }
      if (email) box += await boxDelete("contacts", [{ column: "email", op: "ilike", value: emailPattern! }]);
    }
    results.push({ table: "contacts", central, box });
  }

  // ── phone-keyed content ─────────────────────────────────────────────────
  if (e164) {
    // sms_rowboat_threads (conversation state, PK business_id+customer_e164)
    {
      const { data, error } = await db
        .from("sms_rowboat_threads")
        .delete()
        .eq("business_id", businessId)
        .eq("customer_e164", e164)
        .select("business_id");
      if (error) throw new EndUserDeletionError(`sms_rowboat_threads: ${error.message}`);
      results.push({
        table: "sms_rowboat_threads",
        central: count(data),
        box: api
          ? await boxDelete("sms_rowboat_threads", [
              { column: "customer_e164", op: "eq", value: e164 }
            ])
          : null
      });
    }

    // sms_outbound_log (sends to the person)
    {
      const { data, error } = await db
        .from("sms_outbound_log")
        .delete()
        .eq("business_id", businessId)
        .eq("to_e164", e164)
        .select("id");
      if (error) throw new EndUserDeletionError(`sms_outbound_log: ${error.message}`);
      results.push({
        table: "sms_outbound_log",
        central: count(data),
        box: api
          ? await boxDelete("sms_outbound_log", [{ column: "to_e164", op: "eq", value: e164 }])
          : null
      });
    }

    // unowned_lead_alerts (a claimable team alert ABOUT this person: the row
    // holds their number and name, so erasure has to take it even though the
    // recipients were teammates). Central-only engine state.
    {
      const { data, error } = await db
        .from("unowned_lead_alerts")
        .delete()
        .eq("business_id", businessId)
        .eq("lead_e164", e164)
        .select("id");
      if (error) throw new EndUserDeletionError(`unowned_lead_alerts: ${error.message}`);
      // Central-only, like the other engine/job tables: the row is written by
      // the dispatcher and read by the SMS-inbound Edge function, neither of
      // which goes through a tenant box. Nothing to delete out there.
      results.push({ table: "unowned_lead_alerts", central: count(data), box: null });
    }

    // scheduled_sms (queued + historical sends to the person)
    {
      const { data, error } = await db
        .from("scheduled_sms")
        .delete()
        .eq("business_id", businessId)
        .eq("to_e164", e164)
        .select("id");
      if (error) throw new EndUserDeletionError(`scheduled_sms: ${error.message}`);
      results.push({
        table: "scheduled_sms",
        central: count(data),
        box: api
          ? await boxDelete("scheduled_sms", [{ column: "to_e164", op: "eq", value: e164 }])
          : null
      });
    }

    // sms_owner_reply_prompts (their inbound messages surfaced to the owner)
    {
      const { data, error } = await db
        .from("sms_owner_reply_prompts")
        .delete()
        .eq("business_id", businessId)
        .eq("customer_e164", e164)
        .select("id");
      if (error) throw new EndUserDeletionError(`sms_owner_reply_prompts: ${error.message}`);
      results.push({
        table: "sms_owner_reply_prompts",
        central: count(data),
        box: api
          ? await boxDelete("sms_owner_reply_prompts", [
              { column: "customer_e164", op: "eq", value: e164 }
            ])
          : null
      });
    }

    // voice_call_transcripts + turns. Central turns cascade via FK; the box
    // schema has no FK, so box turns are deleted explicitly by transcript id
    // BEFORE their parents.
    {
      let box: number | null = null;
      if (api) {
        const theirs = await api.select({
          table: "voice_call_transcripts",
          columns: ["id"],
          filters: [
            { column: "business_id", op: "eq", value: businessId },
            { column: "caller_e164", op: "eq", value: e164 }
          ]
        });
        if (!theirs.ok) {
          throw new EndUserDeletionError(
            `box select on voice_call_transcripts failed: ${theirs.message}`
          );
        }
        const ids = theirs.rows.map((r) => String((r as { id: unknown }).id));
        if (ids.length > 0) {
          const turns = await api.delete({
            table: "voice_call_transcript_turns",
            filters: [{ column: "transcript_id", op: "in", value: ids }],
            returning: false
          });
          if (!turns.ok) {
            throw new EndUserDeletionError(
              `box delete on voice_call_transcript_turns failed: ${turns.message}`
            );
          }
        }
        box = await boxDelete("voice_call_transcripts", [
          { column: "caller_e164", op: "eq", value: e164 }
        ]);
      }
      const { data, error } = await db
        .from("voice_call_transcripts")
        .delete()
        .eq("business_id", businessId)
        .eq("caller_e164", e164)
        .select("id");
      if (error) throw new EndUserDeletionError(`voice_call_transcripts: ${error.message}`);
      results.push({ table: "voice_call_transcripts", central: count(data), box });
    }
  }

  // ── email-keyed content ─────────────────────────────────────────────────
  // The delete RETURNING payload carries each row's `attachments` jsonb,
  // whose storage_path entries are the only pointers to the bytes in the
  // email-attachments bucket. Collect them from the deleted rows and remove
  // the objects after: row-first ordering, warn-not-throw on remove failure
  // (an orphaned object with no row is invisible garbage; the reverse is a
  // live row pointing at nothing). Same rationale as documents/cleanup.ts.
  // The bucket is central Supabase Storage, so there is no box equivalent.
  // Runs for every linked email: the request's own, plus the addresses a
  // phone-only request captured from the person's contact rows.
  if (linkedEmails.size > 0) {
    let central = 0;
    let box: number | null = api ? 0 : null;
    const paths: string[] = [];
    const collectPaths = (rows: unknown): void => {
      for (const row of (Array.isArray(rows) ? rows : []) as Array<{ attachments?: unknown }>) {
        for (const att of Array.isArray(row.attachments) ? row.attachments : []) {
          const p = (att as { storage_path?: unknown }).storage_path;
          if (typeof p === "string" && p) paths.push(p);
        }
      }
    };
    for (const em of linkedEmails) {
      const pattern = escapeLikeLiteral(em);
      const [to, from] = await Promise.all([
        db
          .from("email_log")
          .delete()
          .eq("business_id", businessId)
          .ilike("to_email", pattern)
          .select("id, attachments"),
        db
          .from("email_log")
          .delete()
          .eq("business_id", businessId)
          .ilike("from_email", pattern)
          .select("id, attachments")
      ]);
      if (to.error) throw new EndUserDeletionError(`email_log (to): ${to.error.message}`);
      if (from.error) throw new EndUserDeletionError(`email_log (from): ${from.error.message}`);
      central += count(to.data) + count(from.data);
      collectPaths(to.data);
      collectPaths(from.data);
      if (api) {
        // box was initialized to 0 (not null) whenever api is set.
        box =
          (box as number) +
          (await boxDelete("email_log", [{ column: "to_email", op: "ilike", value: pattern }])) +
          (await boxDelete("email_log", [{ column: "from_email", op: "ilike", value: pattern }]));
      }
    }
    results.push({ table: "email_log", central, box });

    if (paths.length > 0) {
      const { error: removeError } = await db.storage.from("email-attachments").remove(paths);
      if (removeError) {
        logger.warn("deleteEndUserData: email-attachments storage remove failed", {
          businessId,
          objectCount: paths.length,
          error: removeError.message
        });
      }
    }
  }

  // ── business_document_shares (document links sent to the person) ────────
  // `shared_with` stores the recipient identifier (phone or email) the link
  // was delivered to: PII. Deleting the row also kills the live link (the
  // download route 404s on a missing share), which is the correct erasure
  // semantic. Central-only table; spans every linked number like
  // ai_reply_reasoning below.
  {
    let central = 0;
    if (linkedNumbers.size > 0) {
      const { data, error } = await db
        .from("business_document_shares")
        .delete()
        .eq("business_id", businessId)
        .in("shared_with", [...linkedNumbers])
        .select("id");
      if (error) throw new EndUserDeletionError(`business_document_shares: ${error.message}`);
      central += count(data);
    }
    for (const em of linkedEmails) {
      const { data, error } = await db
        .from("business_document_shares")
        .delete()
        .eq("business_id", businessId)
        .ilike("shared_with", escapeLikeLiteral(em))
        .select("id");
      if (error) throw new EndUserDeletionError(`business_document_shares: ${error.message}`);
      central += count(data);
    }
    results.push({ table: "business_document_shares", central, box: null });
  }

  // ── document_signature_requests (e-sign requests to the person) ─────────
  // Unsigned/void requests are plain PII rows → deleted. SIGNED requests are
  // standalone legal evidence (ESIGN audit record): the signer identifiers
  // are REDACTED but the signed fact, timestamp, and content fingerprint
  // stay: the same evidence-preserving philosophy as the erasure audit
  // trail itself. Central-only table.
  {
    let central = 0;
    const redaction = {
      signer_name: "",
      signer_email: "",
      signer_phone: "",
      signature_name: "[erased]",
      signer_ip: null,
      signer_user_agent: null
    };
    if (linkedNumbers.size > 0) {
      const { data, error } = await db
        .from("document_signature_requests")
        .delete()
        .eq("business_id", businessId)
        .neq("status", "signed")
        .in("signer_phone", [...linkedNumbers])
        .select("id");
      if (error) throw new EndUserDeletionError(`document_signature_requests: ${error.message}`);
      central += count(data);
      const { data: redacted, error: redactError } = await db
        .from("document_signature_requests")
        .update(redaction)
        .eq("business_id", businessId)
        .eq("status", "signed")
        .in("signer_phone", [...linkedNumbers])
        .select("id");
      if (redactError) {
        throw new EndUserDeletionError(`document_signature_requests: ${redactError.message}`);
      }
      central += count(redacted);
    }
    for (const em of linkedEmails) {
      const pattern = escapeLikeLiteral(em);
      const { data, error } = await db
        .from("document_signature_requests")
        .delete()
        .eq("business_id", businessId)
        .neq("status", "signed")
        .ilike("signer_email", pattern)
        .select("id");
      if (error) throw new EndUserDeletionError(`document_signature_requests: ${error.message}`);
      central += count(data);
      const { data: redacted, error: redactError } = await db
        .from("document_signature_requests")
        .update(redaction)
        .eq("business_id", businessId)
        .eq("status", "signed")
        .ilike("signer_email", pattern)
        .select("id");
      if (redactError) {
        throw new EndUserDeletionError(`document_signature_requests: ${redactError.message}`);
      }
      central += count(redacted);
    }
    results.push({ table: "document_signature_requests", central, box: null });
  }

  // ── ai_reply_reasoning (per-reply AI decision records; central-only) ────
  // Keyed by whichever number the person texted from, so the delete spans
  // every linked number captured pre-delete: the e164 request's primary +
  // merge aliases, AND the numbers an email-only request's contact rows
  // carried. Runs on either identifier axis.
  if (linkedNumbers.size > 0) {
    const { data, error } = await db
      .from("ai_reply_reasoning")
      .delete()
      .eq("business_id", businessId)
      .in("contact_e164", [...linkedNumbers])
      .select("id");
    if (error) throw new EndUserDeletionError(`ai_reply_reasoning: ${error.message}`);
    results.push({ table: "ai_reply_reasoning", central: count(data), box: null });
  }

  // ── sms_links (tracked short links; central-only by design) ────────────
  // Rows persist the recipient number + the original URL from the message
  // body, so they are in scope for erasure. Same linked-number span as
  // ai_reply_reasoning. sms_link_clicks cascade on link delete.
  if (linkedNumbers.size > 0) {
    const { data, error } = await db
      .from("sms_links")
      .delete()
      .eq("business_id", businessId)
      .in("to_e164", [...linkedNumbers])
      .select("id");
    if (error) throw new EndUserDeletionError(`sms_links: ${error.message}`);
    results.push({ table: "sms_links", central: count(data), box: null });
  }

  // ── ai_flow_notify_cooldowns (open notify_owner windows) ───────────────
  // The cooldown key is whatever the flow author templated. Usually an email
  // thread id, but "{{vars.lead_phone}}" is an equally natural choice, and
  // then the row IS keyed to the person. Delete on exact key match across
  // every linked identifier; a row keyed on anything else is untouched.
  // Unconditional: normalizeEndUserIdentifier guarantees at least one
  // identifier, so this set is never empty.
  {
    const { data, error } = await db
      .from("ai_flow_notify_cooldowns")
      .delete()
      .eq("business_id", businessId)
      .in("cooldown_key", [...linkedNumbers, ...linkedEmails])
      .select("business_id");
    if (error) throw new EndUserDeletionError(`ai_flow_notify_cooldowns: ${error.message}`);
    results.push({ table: "ai_flow_notify_cooldowns", central: count(data), box: null });
  }

  // ── kg_retrieval_events (KG comparison ledger; central-only) ───────────
  // Free-text question/answer/context columns can carry the person's phone
  // or email verbatim (a caller stating their number, an answer echoing an
  // email). Substring-ILIKE across the text columns on every identifier
  // axis, deliberately broad: over-deleting comparison telemetry is always
  // preferable to retaining an erased person's data.
  {
    let central = 0;
    const patterns = [
      ...[...linkedNumbers].map((n) => `%${escapeLikeLiteral(n)}%`),
      ...[...linkedEmails].map((em) => `%${escapeLikeLiteral(em)}%`)
    ];
    for (const pattern of patterns) {
      for (const column of ["question", "answer", "graph_context", "memory_context"]) {
        const { data, error } = await db
          .from("kg_retrieval_events")
          .delete()
          .eq("business_id", businessId)
          .ilike(column, pattern)
          .select("id");
        if (error) throw new EndUserDeletionError(`kg_retrieval_events: ${error.message}`);
        central += count(data);
      }
    }
    results.push({ table: "kg_retrieval_events", central, box: null });
  }

  // ── Matching helpers for stores holding RAW phone spellings ─────────────
  // webchat visitor_phone, messenger contact_phone, memory_entities phones,
  // coworker_logs payload values, and outreach phone store whatever the
  // person or tool typed ("(555) 123-4567"), so E.164 equality would miss
  // them. Candidates compare by digit string: exact digits, or last-10
  // digits (NANP local forms drop the +1 country code).
  const digitsOf = (value: string): string => value.replace(/\D+/g, "");
  const linkedDigitForms = new Set<string>();
  for (const n of linkedNumbers) {
    const d = digitsOf(n);
    linkedDigitForms.add(d);
    if (d.length >= 10) linkedDigitForms.add(d.slice(-10));
  }
  const phoneMatches = (raw: unknown): boolean => {
    if (typeof raw !== "string") return false;
    const d = digitsOf(raw);
    if (d.length < 7) return false;
    return linkedDigitForms.has(d) || (d.length >= 10 && linkedDigitForms.has(d.slice(-10)));
  };
  const emailMatches = (raw: unknown): boolean =>
    linkedEmails.size > 0 &&
    typeof raw === "string" &&
    linkedEmails.has(raw.trim().toLowerCase());
  // Free-form jsonb (lead form answers, AiFlow run context): walk every
  // value; a string matches when it contains a linked email or a linked
  // digit sequence. Deliberately broad, same philosophy as the ledger
  // scrub above.
  const jsonValueMatches = (value: unknown): boolean => {
    if (typeof value === "number") return jsonValueMatches(String(value));
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      for (const em of linkedEmails) {
        if (lower.includes(em)) return true;
      }
      const d = digitsOf(value);
      if (d.length < 7) return false;
      for (const form of linkedDigitForms) {
        if (form.length >= 7 && d.includes(form)) return true;
      }
      return false;
    }
    if (Array.isArray(value)) return value.some(jsonValueMatches);
    if (value !== null && typeof value === "object") {
      return Object.values(value as Record<string, unknown>).some(jsonValueMatches);
    }
    return false;
  };

  /**
   * Page a central table ordered by id, filter client-side, return matching
   * ids. Ids are collected first and deleted by the caller AFTER the scan,
   * so deletions never disturb the pagination (same pattern as the box
   * contacts alias scan above).
   */
  const pageMatchIds = async (
    label: string,
    fetchPage: (
      offset: number,
      limit: number
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
    matches: (row: Record<string, unknown>) => boolean
  ): Promise<string[]> => {
    const ids: string[] = [];
    const PAGE = 500;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await fetchPage(offset, PAGE);
      if (error) throw new EndUserDeletionError(`${label} (scan): ${error.message}`);
      const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
      for (const row of rows) {
        if (matches(row)) ids.push(String(row.id));
      }
      if (rows.length < PAGE) break;
    }
    return ids;
  };

  // ── sms_inbound_jobs (the canonical SMS log) ────────────────────────────
  // Inbound texts and cached assistant replies. Modern rows carry
  // customer_e164; legacy rows only have the Telnyx envelope, matched via
  // the payload's sender path. A legacy row whose `from` is the bare string
  // variant is unreachable by column filter and is accepted as residual.
  if (linkedNumbers.size > 0) {
    const numbers = [...linkedNumbers];
    let central = 0;
    {
      const { data, error } = await db
        .from("sms_inbound_jobs")
        .delete()
        .eq("business_id", businessId)
        .in("customer_e164", numbers)
        .select("id");
      if (error) throw new EndUserDeletionError(`sms_inbound_jobs (customer_e164): ${error.message}`);
      central += count(data);
    }
    {
      const { data, error } = await db
        .from("sms_inbound_jobs")
        .delete()
        .eq("business_id", businessId)
        .in("payload->data->payload->from->>phone_number", numbers)
        .select("id");
      if (error) throw new EndUserDeletionError(`sms_inbound_jobs (payload): ${error.message}`);
      central += count(data);
    }
    results.push({ table: "sms_inbound_jobs", central, box: null });
  }

  // ── missed_call_autotexts (auto-text ledger keyed by caller) ────────────
  if (linkedNumbers.size > 0) {
    const { data, error } = await db
      .from("missed_call_autotexts")
      .delete()
      .eq("business_id", businessId)
      .in("caller_e164", [...linkedNumbers])
      .select("id");
    if (error) throw new EndUserDeletionError(`missed_call_autotexts: ${error.message}`);
    results.push({ table: "missed_call_autotexts", central: count(data), box: null });
  }

  // ── meta_capi_events (pending conversion uploads about the lead) ────────
  // Dropping queued rows also stops future hashed-identifier uploads to
  // Meta for the erased person.
  if (linkedNumbers.size > 0) {
    const { data, error } = await db
      .from("meta_capi_events")
      .delete()
      .eq("business_id", businessId)
      .in("contact_e164", [...linkedNumbers])
      .select("id");
    if (error) throw new EndUserDeletionError(`meta_capi_events: ${error.message}`);
    results.push({ table: "meta_capi_events", central: count(data), box: null });
  }

  // ── voice_handoff_sessions (call-chain state + free-text caller brief) ──
  // The context jsonb can hold up to 2000 chars about the caller
  // (ai_takeover.context_note). PK is call_control_id, not id.
  if (linkedNumbers.size > 0) {
    const numbers = [...linkedNumbers];
    let central = 0;
    {
      const { data, error } = await db
        .from("voice_handoff_sessions")
        .delete()
        .eq("business_id", businessId)
        .in("from_e164", numbers)
        .select("call_control_id");
      if (error) throw new EndUserDeletionError(`voice_handoff_sessions (from): ${error.message}`);
      central += count(data);
    }
    {
      const { data, error } = await db
        .from("voice_handoff_sessions")
        .delete()
        .eq("business_id", businessId)
        .in("chain_from_e164", numbers)
        .select("call_control_id");
      if (error) throw new EndUserDeletionError(`voice_handoff_sessions (chain): ${error.message}`);
      central += count(data);
    }
    results.push({ table: "voice_handoff_sessions", central, box: null });
  }

  // ── webchat_sessions (cascades webchat_messages + webchat_jobs) ─────────
  // visitor_phone is stored as typed, so the match is a paged client-side
  // digit comparison; deleting the session cascades the transcript and the
  // job rows (both FK on delete cascade).
  {
    const ids = await pageMatchIds(
      "webchat_sessions",
      (offset, limit) =>
        db
          .from("webchat_sessions")
          .select("id, visitor_phone, visitor_email")
          .eq("business_id", businessId)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1),
      (row) => phoneMatches(row.visitor_phone) || emailMatches(row.visitor_email)
    );
    let central = 0;
    if (ids.length > 0) {
      const { data, error } = await db
        .from("webchat_sessions")
        .delete()
        .eq("business_id", businessId)
        .in("id", ids)
        .select("id");
      if (error) throw new EndUserDeletionError(`webchat_sessions: ${error.message}`);
      central = count(data);
    }
    results.push({ table: "webchat_sessions", central, box: null });
  }

  // ── messenger_conversations (cascades messages + jobs; covers WhatsApp) ─
  // WhatsApp reuses these tables with platform 'whatsapp' and psid set to
  // the customer's wa_id: their phone digits with no plus. Messenger and
  // Instagram psids are opaque page-scoped ids and never match a phone.
  // There is no email column; an email-only request reaches these rows only
  // through the linked numbers captured from the contact.
  if (linkedNumbers.size > 0) {
    const waIds = new Set([...linkedNumbers].map((n) => digitsOf(n)));
    const ids = await pageMatchIds(
      "messenger_conversations",
      (offset, limit) =>
        db
          .from("messenger_conversations")
          .select("id, platform, psid, contact_phone")
          .eq("business_id", businessId)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1),
      (row) =>
        phoneMatches(row.contact_phone) ||
        (row.platform === "whatsapp" && typeof row.psid === "string" && waIds.has(row.psid))
    );
    let central = 0;
    if (ids.length > 0) {
      const { data, error } = await db
        .from("messenger_conversations")
        .delete()
        .eq("business_id", businessId)
        .in("id", ids)
        .select("id");
      if (error) throw new EndUserDeletionError(`messenger_conversations: ${error.message}`);
      central = count(data);
    }
    results.push({ table: "messenger_conversations", central, box: null });
  }

  // ── memory_entities (cascades memory_facts as subject AND object) ───────
  // The graph's phones/emails arrays hold raw extracted spellings, so the
  // match is a paged client-side scan; customer_e164 and attributed_to are
  // exact identifier columns.
  let graphCentral = 0;
  {
    const ids = await pageMatchIds(
      "memory_entities",
      (offset, limit) =>
        db
          .from("memory_entities")
          .select("id, phones, emails, customer_e164, attributed_to")
          .eq("business_id", businessId)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1),
      (row) =>
        (Array.isArray(row.phones) && row.phones.some(phoneMatches)) ||
        (Array.isArray(row.emails) && row.emails.some(emailMatches)) ||
        (typeof row.customer_e164 === "string" && linkedNumbers.has(row.customer_e164)) ||
        phoneMatches(row.attributed_to) ||
        emailMatches(row.attributed_to)
    );
    let central = 0;
    if (ids.length > 0) {
      const { data, error } = await db
        .from("memory_entities")
        .delete()
        .eq("business_id", businessId)
        .in("id", ids)
        .select("id");
      if (error) throw new EndUserDeletionError(`memory_entities: ${error.message}`);
      central = count(data);
    }
    graphCentral += central;
    results.push({ table: "memory_entities", central, box: null });
  }

  // ── memory_facts (residual scrub beyond the entity cascade) ─────────────
  // Facts whose subject or object entity was just deleted are already gone
  // via FK cascade. What remains: facts ATTRIBUTED to the person (their
  // claims about other entities survive the entity delete), and facts whose
  // literal object value or source bullet carries the identifier verbatim.
  {
    let central = 0;
    if (linkedNumbers.size > 0) {
      const { data, error } = await db
        .from("memory_facts")
        .delete()
        .eq("business_id", businessId)
        .in("attributed_to", [...linkedNumbers])
        .select("id");
      if (error) throw new EndUserDeletionError(`memory_facts: ${error.message}`);
      central += count(data);
    }
    // Email attribution is matched with a case-insensitive EXACT ilike
    // (escaped literal, no wildcards): conversational ingestion can persist
    // the raw mailbox casing, which a case-sensitive .in() would miss.
    for (const em of linkedEmails) {
      const { data, error } = await db
        .from("memory_facts")
        .delete()
        .eq("business_id", businessId)
        .ilike("attributed_to", escapeLikeLiteral(em))
        .select("id");
      if (error) throw new EndUserDeletionError(`memory_facts: ${error.message}`);
      central += count(data);
    }
    const patterns = [
      ...[...linkedNumbers].map((n) => `%${escapeLikeLiteral(n)}%`),
      ...[...linkedEmails].map((em) => `%${escapeLikeLiteral(em)}%`)
    ];
    for (const pattern of patterns) {
      for (const column of ["source_text", "object_value"]) {
        const { data, error } = await db
          .from("memory_facts")
          .delete()
          .eq("business_id", businessId)
          .ilike(column, pattern)
          .select("id");
        if (error) throw new EndUserDeletionError(`memory_facts: ${error.message}`);
        central += count(data);
      }
    }
    graphCentral += central;
    results.push({ table: "memory_facts", central, box: null });
  }

  // ── memory graph box re-projection ──────────────────────────────────────
  // The box serves the graph from projected files (entity notes plus
  // graph.jsonl compiled into graph.db) and nothing pushes graph deletions
  // on its own, so without an explicit re-sync the box would keep serving
  // the erased person's notes indefinitely. Re-project now and fail LOUDLY
  // on an unreachable box, exactly like box table deletes: reporting
  // "deleted" while a box copy survives is a false compliance attestation.
  // A tenant with no box assigned has no projection to wipe; that reason is
  // the one acceptable non-ok result.
  if (graphCentral > 0) {
    const sync = await syncVault(businessId);
    if (!sync.ok && sync.reason !== "no_vps_assigned") {
      throw new EndUserDeletionError(
        `memory graph box re-sync failed: ${sync.reason}${sync.detail ? ` (${sync.detail})` : ""}`
      );
    }
  }

  // ── coworker_logs (lead captures inside log_payload) ────────────────────
  // No identifier column exists: person data lives in log_payload under
  // per-writer key vocabularies (webchat: visitorPhone/visitorEmail, the
  // messenger channels: leadPhone/leadEmail, voice tools: callerPhone/
  // callerEmail, the SMS notify-team twin: customerPhone), with phones
  // stored as typed. Page the capture-bearing task types and match
  // client-side. The erasure audit rows (task_type 'data_flow') sit
  // outside the paged set by construction.
  {
    const LOG_TASK_TYPES = ["webchat", "messenger", "instagram", "whatsapp", "call", "sms"];
    const PHONE_KEYS = ["visitorPhone", "leadPhone", "callerPhone", "customerPhone"];
    const EMAIL_KEYS = ["visitorEmail", "leadEmail", "callerEmail", "customerEmail"];
    const ids = await pageMatchIds(
      "coworker_logs",
      (offset, limit) =>
        db
          .from("coworker_logs")
          .select("id, log_payload")
          .eq("business_id", businessId)
          .in("task_type", LOG_TASK_TYPES)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1),
      (row) => {
        const payload = (row.log_payload ?? {}) as Record<string, unknown>;
        return (
          PHONE_KEYS.some((k) => phoneMatches(payload[k])) ||
          EMAIL_KEYS.some((k) => emailMatches(payload[k]))
        );
      }
    );
    let central = 0;
    if (ids.length > 0) {
      const { data, error } = await db
        .from("coworker_logs")
        .delete()
        .eq("business_id", businessId)
        .in("id", ids)
        .select("id");
      if (error) throw new EndUserDeletionError(`coworker_logs: ${error.message}`);
      central = count(data);
    }
    results.push({ table: "coworker_logs", central, box: null });
  }

  // ── ai_flow_runs (cascades ai_flow_run_steps) ───────────────────────────
  // Run context accumulates the trigger payload and every extracted
  // variable (lead phone, email, names), so runs about the person are
  // content about them; identifiers can sit under arbitrary variable names,
  // hence the stringified-context walk. Steps cascade on run delete.
  {
    const ids = await pageMatchIds(
      "ai_flow_runs",
      (offset, limit) =>
        db
          .from("ai_flow_runs")
          .select("id, context")
          .eq("business_id", businessId)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1),
      (row) => jsonValueMatches(row.context)
    );
    let central = 0;
    if (ids.length > 0) {
      const { data, error } = await db
        .from("ai_flow_runs")
        .delete()
        .eq("business_id", businessId)
        .in("id", ids)
        .select("id");
      if (error) throw new EndUserDeletionError(`ai_flow_runs: ${error.message}`);
      central = count(data);
    }
    results.push({ table: "ai_flow_runs", central, box: null });
  }

  // ── lead_submissions (webhook lead events) ──────────────────────────────
  // Indexed deletes on the extracted identifiers first, then a paged
  // residual scan of the raw fields jsonb: extraction is best-effort, and a
  // form whose phone key was not recognized leaves the number only inside
  // `fields` under an arbitrary key.
  {
    let central = 0;
    if (linkedNumbers.size > 0) {
      const { data, error } = await db
        .from("lead_submissions")
        .delete()
        .eq("business_id", businessId)
        .in("phone_e164", [...linkedNumbers])
        .select("id");
      if (error) throw new EndUserDeletionError(`lead_submissions (phone): ${error.message}`);
      central += count(data);
    }
    for (const em of linkedEmails) {
      const { data, error } = await db
        .from("lead_submissions")
        .delete()
        .eq("business_id", businessId)
        .ilike("email", escapeLikeLiteral(em))
        .select("id");
      if (error) throw new EndUserDeletionError(`lead_submissions (email): ${error.message}`);
      central += count(data);
    }
    const ids = await pageMatchIds(
      "lead_submissions",
      (offset, limit) =>
        db
          .from("lead_submissions")
          .select("id, fields")
          .eq("business_id", businessId)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1),
      (row) => jsonValueMatches(row.fields)
    );
    if (ids.length > 0) {
      const { data, error } = await db
        .from("lead_submissions")
        .delete()
        .eq("business_id", businessId)
        .in("id", ids)
        .select("id");
      if (error) throw new EndUserDeletionError(`lead_submissions (residual): ${error.message}`);
      central += count(data);
    }
    results.push({ table: "lead_submissions", central, box: null });
  }

  // ── booking_waitlist (queued slot offers keyed to the person) ───────────
  {
    let central = 0;
    if (linkedNumbers.size > 0) {
      const { data, error } = await db
        .from("booking_waitlist")
        .delete()
        .eq("business_id", businessId)
        .in("phone", [...linkedNumbers])
        .select("id");
      if (error) throw new EndUserDeletionError(`booking_waitlist (phone): ${error.message}`);
      central += count(data);
    }
    for (const em of linkedEmails) {
      const { data, error } = await db
        .from("booking_waitlist")
        .delete()
        .eq("business_id", businessId)
        .ilike("email", escapeLikeLiteral(em))
        .select("id");
      if (error) throw new EndUserDeletionError(`booking_waitlist (email): ${error.message}`);
      central += count(data);
    }
    results.push({ table: "booking_waitlist", central, box: null });
  }

  // ── calendar_booking_dedupe (attendee idempotency ledger) ───────────────
  // attendee_key is phone when known, else email, else name; attendee_email
  // rides the reminder columns. Name-keyed rows are unreachable by
  // identifier and accepted as residual.
  {
    let central = 0;
    if (linkedNumbers.size > 0) {
      const { data, error } = await db
        .from("calendar_booking_dedupe")
        .delete()
        .eq("business_id", businessId)
        .in("attendee_key", [...linkedNumbers])
        .select("id");
      if (error) throw new EndUserDeletionError(`calendar_booking_dedupe (key): ${error.message}`);
      central += count(data);
    }
    for (const em of linkedEmails) {
      const pattern = escapeLikeLiteral(em);
      const byKey = await db
        .from("calendar_booking_dedupe")
        .delete()
        .eq("business_id", businessId)
        .ilike("attendee_key", pattern)
        .select("id");
      if (byKey.error) {
        throw new EndUserDeletionError(`calendar_booking_dedupe (key): ${byKey.error.message}`);
      }
      central += count(byKey.data);
      const byEmail = await db
        .from("calendar_booking_dedupe")
        .delete()
        .eq("business_id", businessId)
        .ilike("attendee_email", pattern)
        .select("id");
      if (byEmail.error) {
        throw new EndUserDeletionError(`calendar_booking_dedupe (email): ${byEmail.error.message}`);
      }
      central += count(byEmail.data);
    }
    results.push({ table: "calendar_booking_dedupe", central, box: null });
  }

  // ── email_coworker_threads (AI mailbox thread map) ──────────────────────
  // One row per correspondent thread; the row exists to describe the
  // correspondent, so it is deleted outright. email_coworker_seen is a
  // message-id dedupe set with no person columns and is exempt.
  if (linkedEmails.size > 0) {
    let central = 0;
    for (const em of linkedEmails) {
      const { data, error } = await db
        .from("email_coworker_threads")
        .delete()
        .eq("business_id", businessId)
        .ilike("correspondent_email", escapeLikeLiteral(em))
        .select("id");
      if (error) throw new EndUserDeletionError(`email_coworker_threads: ${error.message}`);
      central += count(data);
    }
    results.push({ table: "email_coworker_threads", central, box: null });
  }

  // ── email_campaign_recipients (campaign send snapshot rows) ─────────────
  if (linkedEmails.size > 0) {
    let central = 0;
    for (const em of linkedEmails) {
      const { data, error } = await db
        .from("email_campaign_recipients")
        .delete()
        .eq("business_id", businessId)
        .ilike("email", escapeLikeLiteral(em))
        .select("id");
      if (error) throw new EndUserDeletionError(`email_campaign_recipients: ${error.message}`);
      central += count(data);
    }
    results.push({ table: "email_campaign_recipients", central, box: null });
  }

  // ── outreach_prospects (REDACT, never delete: suppression must survive) ─
  // The row is the guarantee nobody is cold-emailed twice: any row for a
  // domain keeps that domain out of future discovery, so deleting it would
  // UN-suppress the person. Strip the PII, keep the domain and the
  // unsubscribed status; the same evidence-preserving shape as the signed
  // signature redaction above. Email matches use the escaped literal
  // (the partial unique index is on lower(email), and nulling the address
  // is safe with respect to it).
  {
    const redaction = {
      business_name: "",
      email: null,
      phone: null,
      website: null,
      findings: [],
      pitch_subject: null,
      pitch_body: null,
      contact_id: null,
      status: "unsubscribed",
      status_detail: "privacy_erasure"
    };
    let central = 0;
    for (const em of linkedEmails) {
      const { data, error } = await db
        .from("outreach_prospects")
        .update(redaction)
        .eq("business_id", businessId)
        .ilike("email", escapeLikeLiteral(em))
        .select("id");
      if (error) throw new EndUserDeletionError(`outreach_prospects (email): ${error.message}`);
      central += count(data);
    }
    if (linkedNumbers.size > 0) {
      const ids = await pageMatchIds(
        "outreach_prospects",
        (offset, limit) =>
          db
            .from("outreach_prospects")
            .select("id, phone")
            .eq("business_id", businessId)
            .order("id", { ascending: true })
            .range(offset, offset + limit - 1),
        (row) => phoneMatches(row.phone)
      );
      if (ids.length > 0) {
        const { data, error } = await db
          .from("outreach_prospects")
          .update(redaction)
          .eq("business_id", businessId)
          .in("id", ids)
          .select("id");
        if (error) throw new EndUserDeletionError(`outreach_prospects (phone): ${error.message}`);
        central += count(data);
      }
    }
    results.push({ table: "outreach_prospects", central, box: null });
  }

  const identifierFingerprint = fingerprintIdentifier(e164, email);
  const totalCentral = results.reduce((s, r) => s + r.central, 0);
  const totalBox = results.reduce((s, r) => s + (r.box ?? 0), 0);
  logger.info("deleteEndUserData: done", {
    businessId,
    identifierFingerprint,
    totalCentral,
    totalBox,
    mode
  });

  return { businessId, identifierFingerprint, tables: results };
}
