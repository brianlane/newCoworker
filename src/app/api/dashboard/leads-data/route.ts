/**
 * Tasks page "Data" view feed.
 *
 * GET /api/dashboard/leads-data?businessId=<uuid>&scope=mine|all
 *   → { rows: LeadDataRow[], columns: string[], employees, myEmployeeId }
 *
 * One row per lead: the newest lead_submissions rows (webhook lead events —
 * Meta Lead Ads direct, the bridges, backlog imports) folded onto contacts
 * by phone/email, plus tagged contacts with no stored submission. `columns`
 * is the dynamic field-column set (union of submission answer keys). All
 * shaping is pure (src/lib/leads/data-view.ts); this route only fetches.
 *
 * Auth: requireBusinessRole(businessId, "view_dashboard") — staff can see
 * it. scope=mine filters to contacts OWNED by the caller's linked roster
 * member, matching /api/dashboard/tasks semantics.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import {
  MAX_LEAD_DATA_ROWS,
  buildLeadDataRows,
  dynamicFieldColumns,
  type LeadContactRow,
  type LeadSubmissionRow
} from "@/lib/leads/data-view";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 30 };

const querySchema = z.object({
  businessId: z.string().uuid(),
  scope: z.enum(["mine", "all"]).default("all")
});

/** Fetch more submissions than rows: several may fold onto one lead. */
const MAX_SUBMISSIONS = 300;

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId, scope } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? "",
      scope: url.searchParams.get("scope") ?? "all"
    });

    if (!user.isAdmin) await requireBusinessRole(businessId, "view_dashboard");

    const limiter = rateLimit(`leads-data:${businessId}:${user.userId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const db = await createSupabaseServiceClient();

    // The caller's linked roster member (drives scope=mine).
    let myEmployeeId: string | null = null;
    if (user.email) {
      const { data: memberRow } = await db
        .from("business_members")
        .select("employee_id")
        .eq("business_id", businessId)
        .eq("email", user.email.trim().toLowerCase())
        .neq("status", "revoked")
        .maybeSingle();
      myEmployeeId =
        (memberRow as { employee_id?: string | null } | null)?.employee_id ?? null;
    }

    // 1) Newest submissions.
    const { data: subData, error: subErr } = await db
      .from("lead_submissions")
      .select("source, leadgen_id, fields, phone_e164, email, created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(MAX_SUBMISSIONS);
    if (subErr) throw new Error(`leads-data: submissions: ${subErr.message}`);
    const submissions = (subData ?? []) as LeadSubmissionRow[];

    // 2) Contacts: everyone matching a submission identifier + every tagged
    //    contact (a lead can be on the board with no stored submission).
    const CONTACT_COLUMNS =
      "customer_e164, alias_e164s, display_name, email, summary_md, tags, owner_employee_id, created_at, updated_at";
    const contactsByPrimary = new Map<string, LeadContactRow>();

    const phones = [
      ...new Set(submissions.map((s) => s.phone_e164).filter((p): p is string => !!p))
    ];
    if (phones.length > 0) {
      // E.164 values are strictly `+digits`, so they are safe in the filter.
      const list = phones.join(",");
      const { data, error } = await db
        .from("contacts")
        .select(CONTACT_COLUMNS)
        .eq("business_id", businessId)
        .or(`customer_e164.in.(${list}),alias_e164s.ov.{${list}}`);
      if (error) throw new Error(`leads-data: contacts by phone: ${error.message}`);
      for (const c of (data ?? []) as LeadContactRow[]) {
        contactsByPrimary.set(c.customer_e164, c);
      }
    }
    const emails = [
      ...new Set(
        submissions
          .map((s) => s.email?.trim().toLowerCase())
          .filter((e): e is string => !!e)
      )
    ];
    if (emails.length > 0) {
      // Emails can contain PostgREST-reserved chars; use an exact-match IN
      // via .in() which escapes values properly.
      const { data, error } = await db
        .from("contacts")
        .select(CONTACT_COLUMNS)
        .eq("business_id", businessId)
        .in("email", emails);
      if (error) throw new Error(`leads-data: contacts by email: ${error.message}`);
      for (const c of (data ?? []) as LeadContactRow[]) {
        if (!contactsByPrimary.has(c.customer_e164)) {
          contactsByPrimary.set(c.customer_e164, c);
        }
      }
    }
    {
      // scope=mine narrows the DB window itself: without this, an owned
      // lead older than the newest-N business-wide tagged contacts could
      // never reach the mine view at all.
      let query = db
        .from("contacts")
        .select(CONTACT_COLUMNS)
        .eq("business_id", businessId)
        .neq("tags", "{}");
      if (scope === "mine" && myEmployeeId) {
        query = query.eq("owner_employee_id", myEmployeeId);
      }
      const { data, error } = await query
        .order("updated_at", { ascending: false })
        .limit(MAX_LEAD_DATA_ROWS);
      if (error) throw new Error(`leads-data: tagged contacts: ${error.message}`);
      for (const c of (data ?? []) as LeadContactRow[]) {
        if (!contactsByPrimary.has(c.customer_e164)) {
          contactsByPrimary.set(c.customer_e164, c);
        }
      }
    }
    const contacts = [...contactsByPrimary.values()];

    // 2b) Supplemental submissions for the contacts themselves: a pipeline
    //     lead whose stored submission is OLDER than the newest-300 window
    //     must still show its answers, so fetch the freshest rows matching
    //     any contact identifier too (duplicates are fine — the fold keeps
    //     the newest per lead).
    const contactPhones = [
      ...new Set(
        contacts.flatMap((c) => [c.customer_e164, ...(c.alias_e164s ?? [])])
      )
    ].filter((p) => /^\+\d+$/.test(p));
    if (contactPhones.length > 0) {
      const { data, error } = await db
        .from("lead_submissions")
        .select("source, leadgen_id, fields, phone_e164, email, created_at")
        .eq("business_id", businessId)
        .in("phone_e164", contactPhones)
        .order("created_at", { ascending: false })
        .limit(MAX_SUBMISSIONS);
      if (error) throw new Error(`leads-data: contact submissions: ${error.message}`);
      submissions.push(...((data ?? []) as LeadSubmissionRow[]));
    }
    const contactEmails = [
      ...new Set(
        contacts
          .map((c) => c.email?.trim().toLowerCase())
          .filter((e): e is string => !!e)
      )
    ];
    if (contactEmails.length > 0) {
      const { data, error } = await db
        .from("lead_submissions")
        .select("source, leadgen_id, fields, phone_e164, email, created_at")
        .eq("business_id", businessId)
        .in("email", contactEmails)
        .order("created_at", { ascending: false })
        .limit(MAX_SUBMISSIONS);
      if (error) {
        throw new Error(`leads-data: contact submissions by email: ${error.message}`);
      }
      submissions.push(...((data ?? []) as LeadSubmissionRow[]));
    }

    // 3) Roster names for owner badges.
    const { data: memberData } = await db
      .from("ai_flow_team_members")
      .select("id, name")
      .eq("business_id", businessId);
    const employees = ((memberData ?? []) as Array<{ id: string; name: string }>).map(
      (m) => ({ id: m.id, name: m.name })
    );
    const employeeNameById = new Map(employees.map((m) => [m.id, m.name]));

    // 4) Display names (owner/employee overlays + manual labels win).
    const contactNames = await resolveContactNames(
      businessId,
      contacts.map((c) => c.customer_e164),
      db
    ).catch(() => new Map<string, ContactName>());

    // Scope BEFORE the row cap (inside the builder), matching Board/List:
    // "mine" with no linked roster member is empty by design — the client
    // explains the linkage instead of showing everyone's leads.
    const rows = buildLeadDataRows({
      submissions,
      contacts,
      contactNames,
      employeeNameById,
      scopeOwnerEmployeeId:
        scope === "mine" ? (myEmployeeId ?? "__no-linked-roster-member__") : null
    });

    return successResponse({
      rows,
      columns: dynamicFieldColumns(rows),
      employees,
      myEmployeeId
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
