/**
 * Business Documents — daily expiration + renewal sweep.
 *
 * Called from /api/internal/document-expiration-sweep (pg_cron → Edge
 * `document-expiration-sweep` → route). Notifies owners about documents
 * expiring within DOCUMENT_EXPIRING_SOON_DAYS, about just-expired ones, and
 * about documents whose RENEWAL date is within DOCUMENT_RENEWAL_SOON_DAYS
 * (policies, leases, contracts — renewal keeps the doc active, unlike
 * expiry) — once per state (armed/cleared stamps on the row, reset whenever
 * the owner changes the date). The exclusion of expired docs from lookups /
 * digests / shares happens at read time; the sweep is purely the reminder
 * half of the guarantee.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";
import { logger } from "@/lib/logger";
import { patchBusinessDocument, type BusinessDocumentRow } from "./db";
import {
  DOCUMENT_EXPIRING_SOON_DAYS,
  DOCUMENT_RENEWAL_SOON_DAYS,
  isDocumentExpired,
  isRenewalDueWithin
} from "./core";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ExpirationSweepDeps = {
  client?: SupabaseClient;
  dispatch?: typeof dispatchUrgentNotification;
  /** Injectable vault re-sync (tests). Never throws (see syncVaultToVpsAndLog). */
  syncVault?: typeof syncVaultToVpsAndLog;
  now?: () => Date;
};

export type ExpirationSweepResult = {
  scanned: number;
  expiringSoonNotified: number;
  expiredNotified: number;
  /** Documents whose renewal date entered the reminder window. */
  renewalDueNotified: number;
  /** Businesses whose on-VPS documents.md digest was re-synced. */
  vaultSyncsTriggered: number;
  errors: Array<{ documentId: string; message: string }>;
};

function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  /* c8 ignore next -- expires_at rows are DB timestamptz, always parseable */
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * One pass over every document with an expiration date. Per-document errors
 * are collected and the sweep continues — notification stamps make re-runs
 * idempotent.
 */
export async function sweepDocumentExpirations(
  deps: ExpirationSweepDeps = {}
): Promise<ExpirationSweepResult> {
  /* c8 ignore start -- production defaults; unit tests inject client, and dispatch/syncVault resolve to the (mocked) module imports */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const dispatch = deps.dispatch ?? dispatchUrgentNotification;
  const syncVault = deps.syncVault ?? syncVaultToVpsAndLog;
  /* c8 ignore stop */
  const now = (deps.now ?? (() => new Date()))();
  const soonCutoffMs = now.getTime() + DOCUMENT_EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000;

  const { data, error } = await db
    .from("business_documents")
    .select()
    .or("expires_at.not.is.null,renewal_date.not.is.null")
    .eq("status", "ready");
  if (error) throw new Error(`sweepDocumentExpirations: ${error.message}`);
  const docs = (data ?? []) as BusinessDocumentRow[];

  const result: ExpirationSweepResult = {
    scanned: docs.length,
    expiringSoonNotified: 0,
    expiredNotified: 0,
    renewalDueNotified: 0,
    vaultSyncsTriggered: 0,
    errors: []
  };

  // Renewal reminders name the contact (policy holder) and the assigned
  // employee, so both directories are pre-fetched in bulk for the docs that
  // will actually notify. Lookup failures degrade to nameless reminders —
  // a directory hiccup must not stop the sweep.
  const renewalCandidates = docs.filter(
    (d) =>
      d.renewal_date &&
      !d.renewal_due_notified_at &&
      isRenewalDueWithin(d, now, DOCUMENT_RENEWAL_SOON_DAYS)
  );
  const contactNames = new Map<string, string>();
  const employeeNames = new Map<string, string>();
  if (renewalCandidates.length > 0) {
    const contactIds = [
      ...new Set(renewalCandidates.map((d) => d.contact_id).filter((id): id is string => !!id))
    ];
    const employeeIds = [
      ...new Set(
        renewalCandidates.map((d) => d.assigned_employee_id).filter((id): id is string => !!id)
      )
    ];
    if (contactIds.length > 0) {
      const { data: contacts, error: contactErr } = await db
        .from("contacts")
        .select("id, display_name, customer_e164")
        .in("id", contactIds);
      if (contactErr) {
        logger.warn("document-expiration-sweep: contact name lookup failed", {
          error: contactErr.message
        });
      }
      for (const c of (contacts ?? []) as Array<{
        id: string;
        display_name: string | null;
        customer_e164: string;
      }>) {
        contactNames.set(c.id, c.display_name?.trim() || c.customer_e164);
      }
    }
    if (employeeIds.length > 0) {
      const { data: members, error: memberErr } = await db
        .from("ai_flow_team_members")
        .select("id, name")
        .in("id", employeeIds);
      if (memberErr) {
        logger.warn("document-expiration-sweep: employee name lookup failed", {
          error: memberErr.message
        });
      }
      for (const m of (members ?? []) as Array<{ id: string; name: string }>) {
        employeeNames.set(m.id, m.name);
      }
    }
  }

  // Businesses with a NEWLY-expired document: their on-VPS documents.md
  // digest still lists the dead title, so the sweep re-syncs the vault for
  // them below (the lookup/share tools already re-check live; the prompt
  // digest is the only stale copy).
  const staleDigestBusinesses = new Set<string>();

  for (const doc of docs) {
    try {
      // ---- Expiration half (docs carrying an expiration date). A doc can
      // carry BOTH dates, so this never short-circuits the renewal half.
      if (doc.expires_at && isDocumentExpired(doc, now)) {
        if (!doc.expired_notified_at) {
          // Registered before the notify so an alert-channel failure still
          // gets the digest refreshed (the notification retries tomorrow).
          staleDigestBusinesses.add(doc.business_id);
          await dispatch({
            businessId: doc.business_id,
            summary: `Document "${doc.title}" has expired`,
            kind: "document_expired",
            payload: { documentId: doc.id, title: doc.title, expiresAt: doc.expires_at },
            emailSubject: `Your document "${doc.title}" has expired`,
            emailBody:
              `"${doc.title}" expired on ${formatDate(doc.expires_at as string)}. ` +
              `Your coworker no longer answers from it or shares it. ` +
              `Upload a replacement or extend the date under Dashboard → Memory → Documents.`,
            smsBody: `[Coworker] Document "${doc.title}" expired — your coworker stopped using it. Update it from the dashboard.`
          });
          await patchBusinessDocument(
            doc.business_id,
            doc.id,
            { expired_notified_at: now.toISOString() },
            db
          );
          result.expiredNotified += 1;
        }
      } else if (doc.expires_at) {
        const expiresMs = Date.parse(doc.expires_at);
        if (expiresMs <= soonCutoffMs && !doc.expiring_soon_notified_at) {
          await dispatch({
            businessId: doc.business_id,
            summary: `Document "${doc.title}" expires ${formatDate(doc.expires_at)}`,
            kind: "document_expiring",
            payload: { documentId: doc.id, title: doc.title, expiresAt: doc.expires_at },
            emailSubject: `Your document "${doc.title}" expires soon`,
            emailBody:
              `"${doc.title}" expires on ${formatDate(doc.expires_at)}. ` +
              `After that your coworker stops answering from it and stops sharing it. ` +
              `Upload a replacement or extend the date under Dashboard → Memory → Documents.`,
            smsBody: `[Coworker] Document "${doc.title}" expires ${formatDate(
              doc.expires_at
            )} — extend or replace it from the dashboard.`
          });
          await patchBusinessDocument(
            doc.business_id,
            doc.id,
            { expiring_soon_notified_at: now.toISOString() },
            db
          );
          result.expiringSoonNotified += 1;
        }
      }

      // ---- Renewal half: the date entering the window reminds ONCE
      // (armed/cleared stamp, reset when renewal_date changes). Overdue
      // dates that were never reminded still fire — a lapsed renewal is
      // more urgent, not less.
      if (
        doc.renewal_date &&
        !doc.renewal_due_notified_at &&
        isRenewalDueWithin(doc, now, DOCUMENT_RENEWAL_SOON_DAYS)
      ) {
        const renewalDay = formatDate(doc.renewal_date);
        const overdue = Date.parse(doc.renewal_date) <= now.getTime();
        const contactName = doc.contact_id ? contactNames.get(doc.contact_id) : undefined;
        const employeeName = doc.assigned_employee_id
          ? employeeNames.get(doc.assigned_employee_id)
          : undefined;
        const forContact = contactName ? ` for ${contactName}` : "";
        const assignedLine = employeeName ? ` Assigned to ${employeeName}.` : "";
        await dispatch({
          businessId: doc.business_id,
          summary: overdue
            ? `"${doc.title}"${forContact} was due for renewal ${renewalDay}`
            : `"${doc.title}"${forContact} renews ${renewalDay}`,
          kind: "document_renewal_due",
          payload: {
            documentId: doc.id,
            title: doc.title,
            renewalDate: doc.renewal_date,
            contactId: doc.contact_id,
            assignedEmployeeId: doc.assigned_employee_id
          },
          emailSubject: overdue
            ? `Renewal overdue: "${doc.title}"${forContact}`
            : `Renewal coming up: "${doc.title}"${forContact}`,
          emailBody:
            `"${doc.title}"${forContact} ${
              overdue ? "was due for renewal on" : "is due for renewal on"
            } ${renewalDay}.${assignedLine} ` +
            `Once it's handled, update the renewal date under Dashboard → Memory → Documents to arm the next reminder.`,
          smsBody: `[Coworker] "${doc.title}"${forContact} ${
            overdue ? "was due for renewal" : "renews"
          } ${renewalDay}.${assignedLine}`
        });
        await patchBusinessDocument(
          doc.business_id,
          doc.id,
          { renewal_due_notified_at: now.toISOString() },
          db
        );
        result.renewalDueNotified += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ documentId: doc.id, message });
      logger.warn("document-expiration-sweep: document failed; continuing", {
        businessId: doc.business_id,
        documentId: doc.id,
        error: message
      });
    }
  }

  // Push the digest change to each affected VPS so the live agent prompt
  // stops listing expired titles. syncVaultToVpsAndLog never throws (a slow
  // or unreachable box logs and leaves the digest to the next sync).
  for (const businessId of staleDigestBusinesses) {
    await syncVault(businessId);
    result.vaultSyncsTriggered += 1;
  }

  return result;
}
