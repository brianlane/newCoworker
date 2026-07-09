/**
 * End-user ("data subject") erasure tooling (security review G6).
 *
 * Deletes one person's data across the tenant's content tables, keyed by
 * their phone number (E.164) and/or email — the two identifiers the
 * platform ever captures for a tenant's customer. Admin-only: the admin
 * route drives this on a verified privacy request (PIPEDA/Law 25 erasure,
 * CCPA delete, etc.) and logs an audit row with a FINGERPRINT of the
 * identifier (never the identifier itself — the audit trail must not
 * re-create the PII it documents removing).
 *
 * Residency interplay:
 *   * Central deletes journal normally (they are real content deletes), so
 *     a dual/vps box receives them as replicated 'delete' ops.
 *   * A vps-mode box also holds history central already purged, which the
 *     journal can't reach — so for dual/vps tenants every table is ALSO
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
  /** sha256 of the normalized identifiers — safe for audit logs. */
  identifierFingerprint: string;
  tables: DeletionTableResult[];
};

export type DeletionDeps = {
  client?: SupabaseClient;
  /** Injectable data-api client factory (tests). */
  dataApiFor?: (businessId: string) => Pick<DataApiClient, "select" | "delete">;
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
 * wildcard-match and erase OTHER people's rows — the exact opposite of a
 * scoped privacy deletion.
 */
export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/* c8 ignore next 2 -- production default; tests inject dataApiFor */
const defaultDataApiFor = (businessId: string): Pick<DataApiClient, "select" | "delete"> =>
  new DataApiClient(businessId);

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
  // Matches customer_e164, alias_e164s membership, or email. Contacts are
  // kept central in every residency mode, so the journaled central delete
  // reaches the box copy; a direct box delete on the primary identifiers
  // still runs for vps tenants as belt-and-braces.
  {
    let central = 0;
    if (e164) {
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
        // contacts and match alias_e164s client-side — collect ids first,
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
  if (email) {
    const central = { sent: 0, received: 0 };
    const [to, from] = await Promise.all([
      db
        .from("email_log")
        .delete()
        .eq("business_id", businessId)
        .ilike("to_email", emailPattern!)
        .select("id"),
      db
        .from("email_log")
        .delete()
        .eq("business_id", businessId)
        .ilike("from_email", emailPattern!)
        .select("id")
    ]);
    if (to.error) throw new EndUserDeletionError(`email_log (to): ${to.error.message}`);
    if (from.error) throw new EndUserDeletionError(`email_log (from): ${from.error.message}`);
    central.sent = count(to.data);
    central.received = count(from.data);
    let box: number | null = null;
    if (api) {
      box =
        (await boxDelete("email_log", [{ column: "to_email", op: "ilike", value: emailPattern! }])) +
        (await boxDelete("email_log", [{ column: "from_email", op: "ilike", value: emailPattern! }]));
    }
    results.push({ table: "email_log", central: central.sent + central.received, box });
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
