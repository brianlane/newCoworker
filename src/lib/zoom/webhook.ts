/**
 * Zoom Marketplace webhook processing (event subscription, Jul 2026):
 *
 *   - `endpoint.url_validation`, Zoom's save-time challenge: reply with the
 *     plainToken and its HMAC under the app's Secret Token.
 *   - `recording.transcript_completed`, the auto-import path: resolve the
 *     tenant from the meeting host's Zoom user id, honor the per-tenant
 *     auto_import_transcripts switch, claim the idempotency ledger, fetch
 *     the VTT (webhook download_token first, the tenant's OAuth token as
 *     fallback), and run the shared import pipeline.
 *   - `app_deauthorized`, Zoom-side uninstall: wipe the dead token pair and
 *     flip the connection inactive so the dashboard shows "Needs reconnect".
 *
 * Every delivery is authenticated by the `x-zm-signature` HMAC (keyed by
 * ZOOM_SECRET_TOKEN) plus a timestamp freshness window. The route
 * (/api/webhooks/zoom) stays thin; everything testable lives here.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getBusiness } from "@/lib/db/businesses";
import {
  getActiveZoomConnectionSummaryByZoomUserId,
  markZoomConnectionDeauthorized
} from "@/lib/db/zoom-connections";
import {
  claimZoomTranscriptImport,
  finalizeZoomTranscriptImport,
  releaseZoomTranscriptImport
} from "@/lib/db/zoom-transcript-imports";
import { recordSystemLog } from "@/lib/db/system-logs";
import { importZoomTranscriptDocument } from "@/lib/zoom/import-core";
import { fetchZoomMeetingTranscript } from "@/lib/zoom/transcript";
import { logger } from "@/lib/logger";

/** Recording payloads carry file lists; far under this in practice. */
export const ZOOM_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
/** Reject deliveries whose timestamp drifts beyond this window. */
export const ZOOM_WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
/** Outbound budget for the webhook's transcript download. */
export const ZOOM_WEBHOOK_DOWNLOAD_TIMEOUT_MS = 20_000;

function webhookSecret(): string | null {
  const secret = (process.env.ZOOM_SECRET_TOKEN ?? "").trim();
  return secret.length > 0 ? secret : null;
}

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Verify `x-zm-signature` ("v0=" + HMAC-SHA256 hex of "v0:{ts}:{rawBody}")
 * and timestamp freshness. False on any missing/malformed input, the
 * route rejects unauthenticated deliveries before parsing.
 */
export function verifyZoomWebhookSignature(
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  now = Date.now()
): boolean {
  const secret = webhookSecret();
  if (!secret || !timestampHeader || !signatureHeader) return false;
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts * 1000) > ZOOM_WEBHOOK_TIMESTAMP_TOLERANCE_MS) return false;
  const expected = `v0=${hmacHex(secret, `v0:${timestampHeader}:${rawBody}`)}`;
  const a = Buffer.from(signatureHeader, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The save-time challenge reply. Null when the secret is not configured. */
export function buildUrlValidationResponse(
  plainToken: string
): { plainToken: string; encryptedToken: string } | null {
  const secret = webhookSecret();
  if (!secret) return null;
  return { plainToken, encryptedToken: hmacHex(secret, plainToken) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export type ZoomWebhookEvent = {
  event: string;
  payload: Record<string, unknown>;
};

/** Normalize a delivery body into { event, payload }. Null when unusable. */
export function parseZoomWebhookBody(body: unknown): ZoomWebhookEvent | null {
  const record = asRecord(body);
  const event = asString(record.event);
  if (!event) return null;
  return { event, payload: asRecord(record.payload) };
}

export type ZoomTranscriptCompleted = {
  hostId: string;
  /** Raw (unencoded) past-meeting instance UUID, the ledger key. */
  meetingUuid: string;
  topic: string | null;
  /** Numeric meeting id, when present (title label). */
  meetingId: string | null;
  /** The transcript file's download URL from the payload, when present. */
  downloadUrl: string | null;
  /** Short-lived download token accompanying the delivery, when present. */
  downloadToken: string | null;
};

/**
 * Pull the fields the auto-import needs out of a recording.transcript_completed
 * payload. Null when the essentials (host id, meeting uuid) are missing.
 */
export function extractTranscriptCompleted(
  event: ZoomWebhookEvent,
  body: unknown
): ZoomTranscriptCompleted | null {
  const object = asRecord(event.payload.object);
  const hostId = asString(object.host_id);
  const meetingUuid = asString(object.uuid);
  if (!hostId || !meetingUuid) return null;

  let downloadUrl: string | null = null;
  const files = Array.isArray(object.recording_files) ? object.recording_files : [];
  for (const file of files) {
    const record = asRecord(file);
    const fileType = asString(record.file_type)?.toUpperCase() ?? null;
    const extension = asString(record.file_extension)?.toUpperCase() ?? null;
    if (fileType === "TRANSCRIPT" || extension === "VTT") {
      downloadUrl = asString(record.download_url);
      if (downloadUrl) break;
    }
  }

  const id = object.id;
  const meetingId =
    typeof id === "number" ? String(id) : (asString(id)?.replace(/\s+/g, "") ?? null);

  return {
    hostId,
    meetingUuid,
    topic: asString(object.topic),
    meetingId: meetingId && /^\d{9,15}$/.test(meetingId) ? meetingId : null,
    downloadUrl,
    downloadToken: asString(asRecord(body).download_token)
  };
}

/**
 * Fetch the VTT via the webhook's own download URL + token (no OAuth
 * round-trip). Null on any failure, the caller falls back to the tenant's
 * connection token.
 */
export async function fetchWebhookTranscriptVtt(
  downloadUrl: string,
  downloadToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), ZOOM_WEBHOOK_DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetchImpl(downloadUrl, {
      headers: { Authorization: `Bearer ${downloadToken}` },
      redirect: "follow",
      signal: ac.signal
    });
    if (!res.ok) return null;
    const vtt = (await res.text()).trim();
    return /^\uFEFF?WEBVTT/.test(vtt) ? vtt : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export type ZoomTranscriptWebhookOutcome =
  /** Imported (document ready or condensation failed, both keep the claim). */
  | "imported"
  /** No active connection for the host, not our tenant. */
  | "no_connection"
  /** The tenant turned auto-import off. */
  | "disabled"
  /** Ledger says this meeting was already handled. */
  | "duplicate"
  /** Payload missing essentials, nothing actionable. */
  | "unusable"
  /** Document cap reached, skipped quietly (claim released). */
  | "skipped_cap"
  /** Transient failure, claim released; the route answers 5xx so Zoom retries. */
  | "import_failed";

export type ZoomWebhookResult =
  | { kind: "url_validation"; response: { plainToken: string; encryptedToken: string } | null }
  | { kind: "deauthorized"; businessId: string | null }
  | { kind: "transcript"; outcome: ZoomTranscriptWebhookOutcome; businessId: string | null }
  | { kind: "ignored"; event: string };

export type ZoomWebhookDeps = {
  connectionByZoomUserId?: typeof getActiveZoomConnectionSummaryByZoomUserId;
  getBusinessFn?: typeof getBusiness;
  claimImport?: typeof claimZoomTranscriptImport;
  releaseImport?: typeof releaseZoomTranscriptImport;
  finalizeImport?: typeof finalizeZoomTranscriptImport;
  fetchWebhookVtt?: typeof fetchWebhookTranscriptVtt;
  fetchConnectionTranscript?: typeof fetchZoomMeetingTranscript;
  importCore?: typeof importZoomTranscriptDocument;
  deauthorize?: typeof markZoomConnectionDeauthorized;
  logSystem?: typeof recordSystemLog;
};

/**
 * Dispatch one verified delivery. Never throws for event-shaped problems,
 * unknown events and unusable payloads return outcomes the route maps to
 * 200 (Zoom must not retry them).
 */
export async function processZoomWebhookEvent(
  body: unknown,
  deps: ZoomWebhookDeps = {}
): Promise<ZoomWebhookResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const connectionByZoomUserId =
    deps.connectionByZoomUserId ?? getActiveZoomConnectionSummaryByZoomUserId;
  const getBusinessFn = deps.getBusinessFn ?? getBusiness;
  const claimImport = deps.claimImport ?? claimZoomTranscriptImport;
  const releaseImport = deps.releaseImport ?? releaseZoomTranscriptImport;
  const finalizeImport = deps.finalizeImport ?? finalizeZoomTranscriptImport;
  const fetchWebhookVtt = deps.fetchWebhookVtt ?? fetchWebhookTranscriptVtt;
  const fetchConnectionTranscript =
    deps.fetchConnectionTranscript ?? fetchZoomMeetingTranscript;
  const importCore = deps.importCore ?? importZoomTranscriptDocument;
  const deauthorize = deps.deauthorize ?? markZoomConnectionDeauthorized;
  const logSystem = deps.logSystem ?? recordSystemLog;
  /* c8 ignore stop */

  const event = parseZoomWebhookBody(body);
  if (!event) return { kind: "ignored", event: "unparseable" };

  if (event.event === "endpoint.url_validation") {
    const plainToken = asString(event.payload.plainToken) ?? "";
    return { kind: "url_validation", response: buildUrlValidationResponse(plainToken) };
  }

  if (event.event === "app_deauthorized") {
    const userId = asString(event.payload.user_id);
    const conn = userId ? await connectionByZoomUserId(userId) : null;
    if (!conn) return { kind: "deauthorized", businessId: null };
    await deauthorize(conn.business_id);
    await logSystem({
      businessId: conn.business_id,
      source: "zoom-webhook",
      event: "zoom_deauthorized",
      level: "info",
      message: "Zoom connection deauthorized from the Zoom side (app uninstalled)"
    });
    return { kind: "deauthorized", businessId: conn.business_id };
  }

  if (event.event === "recording.transcript_completed") {
    const extracted = extractTranscriptCompleted(event, body);
    if (!extracted) return { kind: "transcript", outcome: "unusable", businessId: null };

    const conn = await connectionByZoomUserId(extracted.hostId);
    if (!conn) return { kind: "transcript", outcome: "no_connection", businessId: null };
    const businessId = conn.business_id;
    if (!conn.auto_import_transcripts) {
      return { kind: "transcript", outcome: "disabled", businessId };
    }

    const claimed = await claimImport(businessId, extracted.meetingUuid);
    if (!claimed) return { kind: "transcript", outcome: "duplicate", businessId };

    try {
      let vtt: string | null = null;
      if (extracted.downloadUrl && extracted.downloadToken) {
        vtt = await fetchWebhookVtt(extracted.downloadUrl, extracted.downloadToken);
      }
      if (!vtt) {
        const fetched = await fetchConnectionTranscript(businessId, extracted.meetingUuid);
        vtt = fetched.ok ? fetched.vtt : null;
      }
      if (!vtt) {
        await releaseImport(businessId, extracted.meetingUuid);
        return { kind: "transcript", outcome: "import_failed", businessId };
      }

      const business = await getBusinessFn(businessId);
      if (!business) {
        await releaseImport(businessId, extracted.meetingUuid);
        return { kind: "transcript", outcome: "import_failed", businessId };
      }

      const label = extracted.topic ?? `Zoom meeting ${extracted.meetingId ?? "recording"}`;
      const imported = await importCore({
        businessId,
        business: { name: business.name, tier: business.tier },
        vtt,
        title: `${label} (transcript)`,
        refLabel: extracted.meetingId ?? "recording"
      });

      if (!imported.ok) {
        await releaseImport(businessId, extracted.meetingUuid);
        if (imported.error === "limit_reached") {
          // The meeting already happened; a cap is not an error worth
          // retry-hammering. Log for the owner-facing activity trail.
          await logSystem({
            businessId,
            source: "zoom-webhook",
            event: "zoom_auto_import_skipped_cap",
            level: "warn",
            message: "Zoom auto-import skipped: document limit reached",
            payload: { meetingUuid: extracted.meetingUuid }
          });
          return { kind: "transcript", outcome: "skipped_cap", businessId };
        }
        return { kind: "transcript", outcome: "import_failed", businessId };
      }

      await finalizeImport(businessId, extracted.meetingUuid, imported.document.id);
      return { kind: "transcript", outcome: "imported", businessId };
    } catch (err) {
      await releaseImport(businessId, extracted.meetingUuid);
      logger.warn("zoom webhook: transcript auto-import failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      return { kind: "transcript", outcome: "import_failed", businessId };
    }
  }

  return { kind: "ignored", event: event.event };
}
