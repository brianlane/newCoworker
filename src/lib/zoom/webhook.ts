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
  getActiveZoomConnection,
  getActiveZoomConnectionSummariesByZoomUserId,
  getZoomConnectionBusinessIdsByZoomUserId,
  markZoomConnectionDeauthorized,
  type ZoomConnectionSummary
} from "@/lib/db/zoom-connections";
import {
  claimZoomTranscriptImport,
  finalizeZoomTranscriptImport,
  releaseZoomTranscriptImport
} from "@/lib/db/zoom-transcript-imports";
import { recordSystemLog } from "@/lib/db/system-logs";
import {
  importZoomTranscriptDocument,
  resolveHostNames
} from "@/lib/zoom/import-core";
import {
  buildZoomTranscriptRefLabel,
  buildZoomTranscriptTitle,
  fetchPastMeetingMeta,
  fetchZoomMeetingTranscript
} from "@/lib/zoom/transcript";
import {
  resolveZoomClientEnvFromClientId,
  type ZoomClientEnv
} from "@/lib/zoom/oauth";
import { logger } from "@/lib/logger";

/** Recording payloads carry file lists; far under this in practice. */
export const ZOOM_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
/** Reject deliveries whose timestamp drifts beyond this window. */
export const ZOOM_WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
/** Outbound budget for the webhook's transcript download. */
export const ZOOM_WEBHOOK_DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * The Secret Token to verify with. Zoom's Secret Token is APP-LEVEL: one
 * value covers both the production and development credential pairs, so in
 * practice ZOOM_SECRET_TOKEN verifies every delivery and ZOOM_DEV_SECRET_TOKEN
 * stays unset. The dev slot exists only as a hedge against Zoom ever issuing
 * distinct tokens; nothing routes on which one matched.
 */
function webhookSecret(clientEnv: ZoomClientEnv): string | null {
  const secret = (
    (clientEnv === "development"
      ? process.env.ZOOM_DEV_SECRET_TOKEN
      : process.env.ZOOM_SECRET_TOKEN) ?? ""
  ).trim();
  return secret.length > 0 ? secret : null;
}

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

function signatureMatches(
  secret: string,
  rawBody: string,
  timestampHeader: string,
  signatureHeader: string
): boolean {
  const expected = `v0=${hmacHex(secret, `v0:${timestampHeader}:${rawBody}`)}`;
  const a = Buffer.from(signatureHeader, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify `x-zm-signature` ("v0=" + HMAC-SHA256 hex of "v0:{ts}:{rawBody}")
 * and timestamp freshness, reporting which configured secret matched. Null
 * on any missing/malformed input; the route rejects unauthenticated
 * deliveries before parsing.
 *
 * The matched env is used ONLY to answer url_validation challenges with the
 * same secret. It is NOT an attribution of which Marketplace client sent the
 * delivery: the Secret Token is app-level, shared by both credential pairs,
 * so a development delivery verifies under ZOOM_SECRET_TOKEN and reports
 * "production" here. Tenant routing must never key off this value; the
 * deauthorization path attributes by the payload's client_id instead, and
 * transcript routing is deliberately env-agnostic.
 */
export function verifyZoomWebhookSignature(
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  now = Date.now()
): { clientEnv: ZoomClientEnv } | null {
  if (!timestampHeader || !signatureHeader) return null;
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return null;
  if (Math.abs(now - ts * 1000) > ZOOM_WEBHOOK_TIMESTAMP_TOLERANCE_MS) return null;

  for (const clientEnv of ["production", "development"] as const) {
    const secret = webhookSecret(clientEnv);
    if (!secret) continue;
    if (signatureMatches(secret, rawBody, timestampHeader, signatureHeader)) {
      return { clientEnv };
    }
  }
  return null;
}

/**
 * The save-time challenge reply, answered with the secret of the client that
 * issued the challenge. Null when that client's secret is not configured.
 */
export function buildUrlValidationResponse(
  plainToken: string,
  clientEnv: ZoomClientEnv
): { plainToken: string; encryptedToken: string } | null {
  const secret = webhookSecret(clientEnv);
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
  /** Meeting start time from the payload, when present (ISO). */
  startTime: string | null;
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
    startTime: asString(object.start_time),
    meetingId: meetingId && /^\d{9,15}$/.test(meetingId) ? meetingId : null,
    downloadUrl,
    downloadToken: asString(asRecord(body).download_token)
  };
}

/**
 * The webhook payload's download URL is attacker-controllable in principle
 * (a forged-but-signed body cannot exist, but defense in depth is cheap):
 * only https URLs on Zoom-owned hosts are ever fetched, so the endpoint
 * can't be steered into internal networks (SSRF).
 */
export function isTrustedZoomDownloadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && /(^|\.)zoom\.(us|com)$/i.test(url.hostname);
  } catch {
    return false;
  }
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
  if (!isTrustedZoomDownloadUrl(downloadUrl)) return null;
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
  /**
   * Permanent refusal (document cap reached, transcript over the size
   * ceiling): skipped quietly with a 200 so Zoom does NOT hammer retries at
   * something that cannot succeed; the claim is released so a later manual
   * import (after the owner clears space) stays possible.
   */
  | "skipped_permanent"
  /** Transient failure, claim released; the route answers 5xx so Zoom retries. */
  | "import_failed";

export type ZoomWebhookResult =
  | { kind: "url_validation"; response: { plainToken: string; encryptedToken: string } | null }
  | { kind: "deauthorized"; businessIds: string[] }
  | { kind: "transcript"; outcome: ZoomTranscriptWebhookOutcome; businessId: string | null }
  | { kind: "ignored"; event: string };

export type ZoomWebhookDeps = {
  connectionsByZoomUserId?: typeof getActiveZoomConnectionSummariesByZoomUserId;
  deauthBusinessIdsByZoomUserId?: typeof getZoomConnectionBusinessIdsByZoomUserId;
  getBusinessFn?: typeof getBusiness;
  claimImport?: typeof claimZoomTranscriptImport;
  releaseImport?: typeof releaseZoomTranscriptImport;
  finalizeImport?: typeof finalizeZoomTranscriptImport;
  fetchWebhookVtt?: typeof fetchWebhookTranscriptVtt;
  fetchConnectionTranscript?: typeof fetchZoomMeetingTranscript;
  fetchMeetingMeta?: typeof fetchPastMeetingMeta;
  importCore?: typeof importZoomTranscriptDocument;
  getZoomConnection?: typeof getActiveZoomConnection;
  deauthorize?: typeof markZoomConnectionDeauthorized;
  logSystem?: typeof recordSystemLog;
};

/** Cross-business aggregation: the loudest outcome wins the route status. */
const TRANSCRIPT_OUTCOME_RANK: Record<ZoomTranscriptWebhookOutcome, number> = {
  import_failed: 6,
  imported: 5,
  skipped_permanent: 4,
  duplicate: 3,
  disabled: 2,
  no_connection: 1,
  unusable: 0
};

/**
 * Dispatch one verified delivery. Never throws for event-shaped problems,
 * unknown events and unusable payloads return outcomes the route maps to
 * 200 (Zoom must not retry them).
 *
 * `clientEnv` is which configured secret verified the delivery, and it is
 * used ONLY to answer url_validation with the same secret. It is not trusted
 * for tenant routing (the Secret Token is app-level, so it cannot tell the
 * two clients apart): deauthorization is scoped by the payload's client_id,
 * and transcript routing matches connections in either env, with the
 * per-business import ledger absorbing the dev+prod double delivery.
 */
export async function processZoomWebhookEvent(
  body: unknown,
  clientEnv: ZoomClientEnv,
  deps: ZoomWebhookDeps = {}
): Promise<ZoomWebhookResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const connectionsByZoomUserId =
    deps.connectionsByZoomUserId ?? getActiveZoomConnectionSummariesByZoomUserId;
  const deauthBusinessIdsByZoomUserId =
    deps.deauthBusinessIdsByZoomUserId ?? getZoomConnectionBusinessIdsByZoomUserId;
  const getBusinessFn = deps.getBusinessFn ?? getBusiness;
  const claimImport = deps.claimImport ?? claimZoomTranscriptImport;
  const releaseImport = deps.releaseImport ?? releaseZoomTranscriptImport;
  const finalizeImport = deps.finalizeImport ?? finalizeZoomTranscriptImport;
  const fetchWebhookVtt = deps.fetchWebhookVtt ?? fetchWebhookTranscriptVtt;
  const fetchConnectionTranscript =
    deps.fetchConnectionTranscript ?? fetchZoomMeetingTranscript;
  const fetchMeetingMeta = deps.fetchMeetingMeta ?? fetchPastMeetingMeta;
  const importCore = deps.importCore ?? importZoomTranscriptDocument;
  /* c8 ignore next -- production default; tests inject */
  const getConnection = deps.getZoomConnection ?? getActiveZoomConnection;
  const deauthorize = deps.deauthorize ?? markZoomConnectionDeauthorized;
  const logSystem = deps.logSystem ?? recordSystemLog;
  /* c8 ignore stop */

  const event = parseZoomWebhookBody(body);
  if (!event) return { kind: "ignored", event: "unparseable" };

  if (event.event === "endpoint.url_validation") {
    const plainToken = asString(event.payload.plainToken) ?? "";
    return {
      kind: "url_validation",
      response: buildUrlValidationResponse(plainToken, clientEnv)
    };
  }

  if (event.event === "app_deauthorized") {
    const userId = asString(event.payload.user_id);
    // Which CLIENT the user deauthorized comes from the payload, not the
    // signature: the shared Secret Token authenticates the delivery but a
    // dev-client uninstall must not wipe a production tenant that shares the
    // Zoom account. An unrecognized/missing client_id falls back to wiping
    // every env's rows, the pre-dual-client behavior: over-wiping shows as
    // "Needs reconnect", under-wiping leaves dead ciphertext stored.
    const payloadClientId = asString(event.payload.client_id);
    const deauthEnv = payloadClientId
      ? resolveZoomClientEnvFromClientId(payloadClientId)
      : null;
    // ALL rows for the user under that client, active or not: a soft-disabled
    // connection's ciphertext must not survive a Zoom-side uninstall.
    const businessIds = userId ? await deauthBusinessIdsByZoomUserId(userId, deauthEnv) : [];
    for (const businessId of businessIds) {
      await deauthorize(businessId);
      await logSystem({
        businessId,
        source: "zoom-webhook",
        event: "zoom_deauthorized",
        level: "info",
        message: "Zoom connection deauthorized from the Zoom side (app uninstalled)"
      });
    }
    return { kind: "deauthorized", businessIds };
  }

  if (event.event === "recording.transcript_completed") {
    const extracted = extractTranscriptCompleted(event, body);
    if (!extracted) return { kind: "transcript", outcome: "unusable", businessId: null };

    // Env-agnostic on purpose: recording payloads carry no client id, and
    // when the host is connected under both clients Zoom delivers once per
    // event subscription anyway; the per-business ledger claim makes the
    // second delivery a no-op instead of a duplicate document.
    const conns = await connectionsByZoomUserId(extracted.hostId);
    if (conns.length === 0) {
      return { kind: "transcript", outcome: "no_connection", businessId: null };
    }

    const importForBusiness = async (
      conn: ZoomConnectionSummary
    ): Promise<{ outcome: ZoomTranscriptWebhookOutcome; businessId: string }> => {
      const businessId = conn.business_id;
      if (!conn.auto_import_transcripts) return { outcome: "disabled", businessId };

      const claimed = await claimImport(businessId, extracted.meetingUuid);
      if (!claimed) return { outcome: "duplicate", businessId };

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
          return { outcome: "import_failed", businessId };
        }

        const business = await getBusinessFn(businessId);
        if (!business) {
          await releaseImport(businessId, extracted.meetingUuid);
          return { outcome: "import_failed", businessId };
        }

        // Payload topic/start_time first; fill gaps from past_meetings so
        // untitled webhook deliveries still get a dated library title.
        let topic = extracted.topic;
        let startTime = extracted.startTime;
        let meetingId = extracted.meetingId;
        if (!topic || !startTime || !meetingId) {
          const meta = await fetchMeetingMeta(businessId, extracted.meetingUuid);
          topic = topic ?? meta?.topic ?? null;
          startTime = startTime ?? meta?.startTime ?? null;
          meetingId = meetingId ?? meta?.meetingId ?? null;
        }
        const titleBits = { topic, startTime, meetingId };
        // The host speaks under their Zoom display name, not the business
        // name, so both are needed to tell "us" from the guest. Best-effort:
        // a nicer title is never worth failing an import over.
        const hostNames = await resolveHostNames(business.name, () =>
          getConnection(businessId)
        );
        const imported = await importCore({
          businessId,
          business: { name: business.name, tier: business.tier },
          vtt,
          title: buildZoomTranscriptTitle(titleBits),
          refLabel: buildZoomTranscriptRefLabel(titleBits),
          hostNames,
          // Drives the post-import classification: the UUID is its
          // exactly-once key (same one the ledger claim above used), the
          // numeric id joins the booking ledger to attribute the meeting.
          meetingUuid: extracted.meetingUuid,
          zoomMeetingId: meetingId
        });

        if (!imported.ok) {
          await releaseImport(businessId, extracted.meetingUuid);
          if (imported.error === "limit_reached" || imported.error === "too_large") {
            // Permanent refusals: retrying cannot change the outcome, so
            // answer 200 (Zoom stops redelivering) and log for the
            // owner-facing activity trail.
            await logSystem({
              businessId,
              source: "zoom-webhook",
              event:
                imported.error === "limit_reached"
                  ? "zoom_auto_import_skipped_cap"
                  : "zoom_auto_import_skipped_too_large",
              level: "warn",
              message:
                imported.error === "limit_reached"
                  ? "Zoom auto-import skipped: document limit reached"
                  : "Zoom auto-import skipped: transcript over the 10 MB limit",
              payload: { meetingUuid: extracted.meetingUuid }
            });
            return { outcome: "skipped_permanent", businessId };
          }
          return { outcome: "import_failed", businessId };
        }

        // The import succeeded; a claim left at document_id null would let
        // the lease steal re-import a duplicate, so retry the stamp once
        // and escalate loudly if it still fails (row is repairable by ops;
        // the claim is deliberately KEPT so redeliveries stay no-ops).
        const finalized =
          (await finalizeImport(businessId, extracted.meetingUuid, imported.document.id)) ||
          (await finalizeImport(businessId, extracted.meetingUuid, imported.document.id));
        if (!finalized) {
          await logSystem({
            businessId,
            source: "zoom-webhook",
            event: "zoom_ledger_finalize_failed",
            level: "error",
            message:
              "Zoom auto-import succeeded but the ledger stamp failed twice; repair zoom_transcript_imports.document_id to prevent a lease-steal duplicate",
            payload: { meetingUuid: extracted.meetingUuid, documentId: imported.document.id }
          });
        }
        return { outcome: "imported", businessId };
      } catch (err) {
        await releaseImport(businessId, extracted.meetingUuid);
        logger.warn("zoom webhook: transcript auto-import failed", {
          businessId,
          error: err instanceof Error ? err.message : String(err)
        });
        return { outcome: "import_failed", businessId };
      }
    };

    // One Zoom account can back multiple businesses: import for each. The
    // loudest outcome drives the route status; an import_failed answer makes
    // Zoom redeliver, and the per-business ledger claims no-op the ones that
    // already succeeded.
    let loudest: { outcome: ZoomTranscriptWebhookOutcome; businessId: string } | null = null;
    for (const conn of conns) {
      const result = await importForBusiness(conn);
      if (
        !loudest ||
        TRANSCRIPT_OUTCOME_RANK[result.outcome] > TRANSCRIPT_OUTCOME_RANK[loudest.outcome]
      ) {
        loudest = result;
      }
    }
    /* c8 ignore next -- conns is non-empty, the loop always sets loudest */
    if (!loudest) return { kind: "transcript", outcome: "no_connection", businessId: null };
    return { kind: "transcript", outcome: loudest.outcome, businessId: loudest.businessId };
  }

  return { kind: "ignored", event: event.event };
}

