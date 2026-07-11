/**
 * Business Documents — daily expiration sweep.
 *
 * Called from /api/internal/document-expiration-sweep (pg_cron → Edge
 * `document-expiration-sweep` → route). Notifies owners about documents
 * expiring within DOCUMENT_EXPIRING_SOON_DAYS and about just-expired ones —
 * once per state (armed/cleared stamps on the row, reset whenever the owner
 * changes `expires_at`). The exclusion of expired docs from lookups /
 * digests / shares happens at read time; the sweep is purely the reminder
 * half of the guarantee.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { logger } from "@/lib/logger";
import { patchBusinessDocument, type BusinessDocumentRow } from "./db";
import { DOCUMENT_EXPIRING_SOON_DAYS, isDocumentExpired } from "./core";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ExpirationSweepDeps = {
  client?: SupabaseClient;
  dispatch?: typeof dispatchUrgentNotification;
  now?: () => Date;
};

export type ExpirationSweepResult = {
  scanned: number;
  expiringSoonNotified: number;
  expiredNotified: number;
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
  /* c8 ignore start -- production defaults; unit tests inject client, and dispatch resolves to the (mocked) module import */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const dispatch = deps.dispatch ?? dispatchUrgentNotification;
  /* c8 ignore stop */
  const now = (deps.now ?? (() => new Date()))();
  const soonCutoffMs = now.getTime() + DOCUMENT_EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000;

  const { data, error } = await db
    .from("business_documents")
    .select()
    .not("expires_at", "is", null)
    .eq("status", "ready");
  if (error) throw new Error(`sweepDocumentExpirations: ${error.message}`);
  const docs = (data ?? []) as BusinessDocumentRow[];

  const result: ExpirationSweepResult = {
    scanned: docs.length,
    expiringSoonNotified: 0,
    expiredNotified: 0,
    errors: []
  };

  for (const doc of docs) {
    try {
      if (isDocumentExpired(doc, now)) {
        if (doc.expired_notified_at) continue;
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
        continue;
      }
      const expiresMs = Date.parse(doc.expires_at as string);
      if (expiresMs <= soonCutoffMs && !doc.expiring_soon_notified_at) {
        await dispatch({
          businessId: doc.business_id,
          summary: `Document "${doc.title}" expires ${formatDate(doc.expires_at as string)}`,
          kind: "document_expiring",
          payload: { documentId: doc.id, title: doc.title, expiresAt: doc.expires_at },
          emailSubject: `Your document "${doc.title}" expires soon`,
          emailBody:
            `"${doc.title}" expires on ${formatDate(doc.expires_at as string)}. ` +
            `After that your coworker stops answering from it and stops sharing it. ` +
            `Upload a replacement or extend the date under Dashboard → Memory → Documents.`,
          smsBody: `[Coworker] Document "${doc.title}" expires ${formatDate(
            doc.expires_at as string
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

  return result;
}
