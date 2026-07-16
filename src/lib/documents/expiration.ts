/**
 * Business Documents — daily expiration + renewal sweep.
 *
 * Called from /api/internal/document-expiration-sweep (pg_cron → Edge
 * `document-expiration-sweep` → route). Notifies owners about documents
 * expiring within DOCUMENT_EXPIRING_SOON_DAYS and about just-expired ones,
 * and runs the RENEWAL escalation ladder for documents carrying a renewal
 * date (policies, leases, contracts — renewal keeps the doc active, unlike
 * expiry):
 *
 *   ~30 days out  - heads-up            (renewal_due_notified_at)
 *   ~7 days out   - final reminder      (renewal_final_notified_at)
 *   past due      - overdue notice      (renewal_overdue_notified_at)
 *
 * Each tier fires ONCE (armed/cleared stamps, reset whenever the owner
 * changes the date). A late-entering date fires only its most urgent tier.
 * Every tier notifies the owner channels AND texts the assigned employee
 * directly (operational metering — counted, never refused). Entering the
 * window also fires ONE `document_renewal` webhook flow event so an
 * owner-enabled AiFlow can reach out to the customer to update their
 * information — no flow enabled, no outreach.
 *
 * The exclusion of expired docs from lookups / digests / shares happens at
 * read time; the sweep is purely the reminder half of the guarantee.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { processWebhookFlowEvent } from "@/lib/ai-flows/webhook-events";
import { logger } from "@/lib/logger";
import { patchBusinessDocument, type BusinessDocumentPatch, type BusinessDocumentRow } from "./db";
import {
  DOCUMENT_EXPIRING_SOON_DAYS,
  DOCUMENT_RENEWAL_FINAL_DAYS,
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
  /** Renewal heads-up reminders (~30 days out) sent this pass. */
  renewalDueNotified: number;
  /** Final renewal reminders (~7 days out) sent this pass. */
  renewalFinalNotified: number;
  /** Past-due renewal notices sent this pass. */
  renewalOverdueNotified: number;
  /** document_renewal outreach flow events enqueued this pass. */
  renewalOutreachEnqueued: number;
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
  /* c8 ignore start -- production defaults; unit tests inject client, and the rest resolve to the (mocked) module imports */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const dispatch = deps.dispatch ?? dispatchUrgentNotification;
  const syncVault = deps.syncVault ?? syncVaultToVpsAndLog;
  const getMessagingConfig = getTelnyxMessagingForBusiness;
  const sendSms = sendTelnyxSms;
  const processFlowEvent = processWebhookFlowEvent;
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
    renewalFinalNotified: 0,
    renewalOverdueNotified: 0,
    renewalOutreachEnqueued: 0,
    vaultSyncsTriggered: 0,
    errors: []
  };

  // Renewal reminders name the contact (policy holder) and the assigned
  // employee — and the outreach event carries the contact's reachables — so
  // both directories are pre-fetched in bulk for every doc inside the
  // renewal window (any tier or the outreach could still fire for it).
  // Lookup failures degrade to nameless reminders — a directory hiccup must
  // not stop the sweep.
  const renewalCandidates = docs.filter(
    (d) => d.renewal_date && isRenewalDueWithin(d, now, DOCUMENT_RENEWAL_SOON_DAYS)
  );
  const contactsById = new Map<
    string,
    { name: string; phone: string; email: string | null }
  >();
  const employeesById = new Map<string, { name: string; phone: string }>();
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
        .select("id, display_name, customer_e164, email")
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
        email: string | null;
      }>) {
        contactsById.set(c.id, {
          name: c.display_name?.trim() || c.customer_e164,
          phone: c.customer_e164,
          email: c.email
        });
      }
    }
    if (employeeIds.length > 0) {
      const { data: members, error: memberErr } = await db
        .from("ai_flow_team_members")
        .select("id, name, phone_e164")
        .in("id", employeeIds);
      if (memberErr) {
        logger.warn("document-expiration-sweep: employee name lookup failed", {
          error: memberErr.message
        });
      }
      for (const m of (members ?? []) as Array<{ id: string; name: string; phone_e164: string }>) {
        employeesById.set(m.id, { name: m.name, phone: m.phone_e164 });
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

      // ---- Renewal half: the escalation ladder. Each tier fires ONCE
      // (armed/cleared stamps, reset when renewal_date changes); a
      // late-entering date fires only its most urgent applicable tier and
      // stamps the milder ones it skipped past.
      if (doc.renewal_date && isRenewalDueWithin(doc, now, DOCUMENT_RENEWAL_SOON_DAYS)) {
        const renewalMs = Date.parse(doc.renewal_date);
        const overdueApplicable = renewalMs <= now.getTime();
        const finalApplicable =
          renewalMs <= now.getTime() + DOCUMENT_RENEWAL_FINAL_DAYS * 24 * 60 * 60 * 1000;

        let tier: "overdue" | "final" | "soon" | null = null;
        if (overdueApplicable) {
          if (!doc.renewal_overdue_notified_at) tier = "overdue";
        } else if (finalApplicable) {
          if (!doc.renewal_final_notified_at) tier = "final";
        } else if (!doc.renewal_due_notified_at) {
          tier = "soon";
        }

        const renewalDay = formatDate(doc.renewal_date);
        const contact = doc.contact_id ? contactsById.get(doc.contact_id) : undefined;
        const employee = doc.assigned_employee_id
          ? employeesById.get(doc.assigned_employee_id)
          : undefined;
        const forContact = contact ? ` for ${contact.name}` : "";
        const assignedLine = employee ? ` Assigned to ${employee.name}.` : "";

        if (tier) {
          const headline =
            tier === "overdue"
              ? `"${doc.title}"${forContact} was due for renewal ${renewalDay}`
              : tier === "final"
                ? `Final reminder: "${doc.title}"${forContact} renews ${renewalDay}`
                : `"${doc.title}"${forContact} renews ${renewalDay}`;
          const kind =
            tier === "overdue"
              ? "document_renewal_overdue"
              : tier === "final"
                ? "document_renewal_final"
                : "document_renewal_due";
          await dispatch({
            businessId: doc.business_id,
            summary: headline,
            kind,
            payload: {
              documentId: doc.id,
              title: doc.title,
              renewalDate: doc.renewal_date,
              tier,
              contactId: doc.contact_id,
              assignedEmployeeId: doc.assigned_employee_id
            },
            emailSubject:
              tier === "overdue"
                ? `Renewal overdue: "${doc.title}"${forContact}`
                : tier === "final"
                  ? `Final reminder: "${doc.title}"${forContact} renews ${renewalDay}`
                  : `Renewal coming up: "${doc.title}"${forContact}`,
            emailBody:
              `"${doc.title}"${forContact} ${
                tier === "overdue" ? "was due for renewal on" : "is due for renewal on"
              } ${renewalDay}.${assignedLine} ` +
              `Once it's handled, update the renewal date under Dashboard → Memory → Documents to arm the next reminder.`,
            smsBody: `[Coworker] ${headline}.${assignedLine}`
          });

          // Direct text to the assigned employee (owner alerts above go to
          // the OWNER's channels). Operational metering: counted, never
          // refused. Best-effort — a carrier hiccup must not re-fire the
          // whole tier tomorrow, so failures log and move on.
          if (employee?.phone) {
            try {
              const config = await getMessagingConfig(doc.business_id);
              await sendSms(config, employee.phone, `[Coworker] ${headline}. You're the assigned handler.`, {
                meterBusinessId: doc.business_id,
                meterMode: "operational"
              });
            } catch (smsErr) {
              logger.warn("document-expiration-sweep: assignee SMS failed", {
                businessId: doc.business_id,
                documentId: doc.id,
                error: smsErr instanceof Error ? smsErr.message : String(smsErr)
              });
            }
          }

          // Stamp the fired tier AND every milder tier it skipped past, so
          // a late-entering date never double-fires on the next pass.
          const stamps: BusinessDocumentPatch = {};
          const nowIso = now.toISOString();
          if (!doc.renewal_due_notified_at) stamps.renewal_due_notified_at = nowIso;
          if (finalApplicable && !doc.renewal_final_notified_at) {
            stamps.renewal_final_notified_at = nowIso;
          }
          if (overdueApplicable && !doc.renewal_overdue_notified_at) {
            stamps.renewal_overdue_notified_at = nowIso;
          }
          await patchBusinessDocument(doc.business_id, doc.id, stamps, db);
          if (tier === "overdue") result.renewalOverdueNotified += 1;
          else if (tier === "final") result.renewalFinalNotified += 1;
          else result.renewalDueNotified += 1;
        }

        // Customer outreach: ONE document_renewal flow event per renewal
        // date (stamped separately from the reminder tiers, so documents
        // that were reminded before this shipped still get outreach).
        // Requires a linked, resolvable contact — outreach without a person
        // to reach is meaningless (an unlinked doc skips WITHOUT stamping,
        // so linking a contact later still fires). Nothing happens unless
        // the owner enabled a webhook flow matching the source — fired
        // AFTER the tier stamps so an enqueue failure retries tomorrow
        // without re-sending reminders.
        if (!doc.renewal_outreach_enqueued_at && contact) {
          await processFlowEvent(
            doc.business_id,
            {
              source: "document_renewal",
              eventId: `document_renewal:${doc.id}:${doc.renewal_date}`,
              data: {
                document_title: doc.title,
                category: doc.category,
                renewal_date: renewalDay,
                days_until_renewal: Math.max(
                  0,
                  Math.ceil((renewalMs - now.getTime()) / 86_400_000)
                ),
                contact_name: contact.name,
                contact_phone: contact.phone,
                contact_email: contact.email ?? "",
                assigned_employee: employee?.name ?? ""
              }
            },
            db
          );
          await patchBusinessDocument(
            doc.business_id,
            doc.id,
            { renewal_outreach_enqueued_at: now.toISOString() },
            db
          );
          result.renewalOutreachEnqueued += 1;
        }
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
