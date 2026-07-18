/**
 * Zoom meeting transcript fetch — the `cloud_recording:read:meeting_transcript`
 * scope added to the "New Coworker OAuth" Marketplace app (2026-07-17).
 *
 * `GET /meetings/{meetingId}/transcript` reports whether the cloud-recording
 * transcript can be downloaded (`can_download` + `download_url`, else a
 * `download_restriction_reason`); the VTT itself is then fetched from the
 * download URL with the same bearer token.
 *
 * Direct (first-party) connections only: the transcript scope is granted to
 * OUR OAuth app, so legacy Nango-proxied Zoom links can never carry it.
 * Errors are typed for the owner-facing import flow — every failure mode
 * maps to an actionable message, never a bare 500.
 */
import { logger } from "@/lib/logger";
import { getZoomAccessToken } from "@/lib/zoom/client";
import { ZOOM_API_BASE_URL } from "@/lib/zoom/oauth";

/** Outbound budget per call — fail fast on a stuck upstream. */
export const ZOOM_TRANSCRIPT_TIMEOUT_MS = 20_000;

export type ZoomTranscriptError =
  /** No active direct Zoom connection, or the token lacks the transcript scope. */
  | "not_connected"
  /** Zoom has no transcript for this meeting id. */
  | "not_found"
  /** Transcript exists but Zoom refuses the download (restriction reason attached). */
  | "restricted"
  /** Transport/API failure — retryable. */
  | "request_failed";

export type ZoomTranscriptResult =
  | { ok: true; vtt: string }
  | { ok: false; error: ZoomTranscriptError; detail: string };

type TranscriptDeps = {
  /** Injectable token resolver (tests). */
  getToken?: (businessId: string) => Promise<string | null>;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
};

async function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>
): Promise<Response> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), ZOOM_TRANSCRIPT_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { headers, redirect: "follow", signal: ac.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the cloud-recording transcript (raw WebVTT text) for one of the
 * connected account's meetings. Never throws — every failure returns a
 * typed, owner-presentable result.
 */
export async function fetchZoomMeetingTranscript(
  businessId: string,
  meetingId: string,
  deps: TranscriptDeps = {}
): Promise<ZoomTranscriptResult> {
  const getToken = deps.getToken ?? getZoomAccessToken;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let token: string | null;
  try {
    token = await getToken(businessId);
  } catch (err) {
    logger.warn("zoom transcript: token resolution failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return {
      ok: false,
      error: "request_failed",
      detail: "Could not reach Zoom to refresh the connection — try again shortly."
    };
  }
  if (!token) {
    return {
      ok: false,
      error: "not_connected",
      detail: "No active Zoom connection — connect Zoom on the Integrations page first."
    };
  }

  let metaRes: Response;
  try {
    metaRes = await timedFetch(
      fetchImpl,
      `${ZOOM_API_BASE_URL}/meetings/${encodeURIComponent(meetingId)}/transcript`,
      { Authorization: `Bearer ${token}`, Accept: "application/json" }
    );
  } catch {
    return {
      ok: false,
      error: "request_failed",
      detail: "Zoom did not respond — try again shortly."
    };
  }

  if (metaRes.status === 401 || metaRes.status === 403) {
    // Insufficient scope or revoked token: connections made before the
    // transcript scope shipped don't carry it — reconnect re-consents.
    return {
      ok: false,
      error: "not_connected",
      detail:
        "Zoom rejected the request. Reconnect Zoom on the Integrations page to grant the meeting-transcript permission."
    };
  }
  if (metaRes.status === 404) {
    return {
      ok: false,
      error: "not_found",
      detail:
        "Zoom has no transcript for that meeting. Check the meeting ID, make sure it was cloud-recorded with audio transcript on, and allow a few minutes after the meeting for processing."
    };
  }
  if (!metaRes.ok) {
    logger.warn("zoom transcript: lookup failed", {
      businessId,
      status: metaRes.status
    });
    return {
      ok: false,
      error: "request_failed",
      detail: `Zoom transcript lookup failed (${metaRes.status}).`
    };
  }

  const meta = (await metaRes.json().catch(() => null)) as {
    can_download?: boolean;
    download_url?: string;
    download_restriction_reason?: string;
  } | null;
  if (!meta?.can_download || typeof meta.download_url !== "string") {
    return {
      ok: false,
      error: "restricted",
      detail: meta?.download_restriction_reason
        ? `Zoom won't allow this transcript to be downloaded: ${meta.download_restriction_reason}`
        : "Zoom won't allow this transcript to be downloaded."
    };
  }

  let dlRes: Response;
  try {
    dlRes = await timedFetch(fetchImpl, meta.download_url, {
      Authorization: `Bearer ${token}`
    });
  } catch {
    return {
      ok: false,
      error: "request_failed",
      detail: "The transcript download timed out — try again shortly."
    };
  }
  if (!dlRes.ok) {
    logger.warn("zoom transcript: download failed", {
      businessId,
      status: dlRes.status
    });
    return {
      ok: false,
      error: "request_failed",
      detail: `The transcript download failed (${dlRes.status}).`
    };
  }

  const vtt = (await dlRes.text()).trim();
  if (!/^\uFEFF?WEBVTT/.test(vtt)) {
    // A login page or error body instead of a transcript — refuse rather
    // than ingest garbage into the owner's document library.
    return {
      ok: false,
      error: "request_failed",
      detail: "Zoom returned something that isn't a VTT transcript — try again shortly."
    };
  }
  return { ok: true, vtt };
}
