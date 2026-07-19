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

/**
 * Normalize an owner-pasted meeting reference into the path segment the
 * transcript endpoint accepts. Zoom's `GET /meetings/{id}/transcript`
 * resolves ONLY the past-meeting instance UUID for instant/ended meetings —
 * the numeric meeting id 404s (code 3322) even when the portal shows a
 * transcript — so owners can paste any of:
 *
 *   - the numeric meeting ID ("876 3018 1550"), kept for scheduled meetings;
 *   - the meeting UUID ("jhqVQlf1RyuEX/1TCRs+Jg==");
 *   - the recording page link (…zoom.us/recording/detail?meeting_id=<uuid>),
 *     which carries the exact UUID the endpoint wants.
 *
 * Per Zoom's docs, UUIDs beginning with "/" or containing "//" must be
 * DOUBLE URL-encoded; every UUID needs at least one encoding pass ("+", "/",
 * "=" are not path-safe). Returns null when the input is none of the above.
 */
export function normalizeZoomMeetingRef(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;

  // Recording page / share link: the meeting_id query param is the UUID
  // (URLSearchParams decodes the %2F / %2B / %3D escapes for us).
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (!/(^|\.)zoom\.(us|com)$/i.test(url.hostname)) return null;
      const uuid = url.searchParams.get("meeting_id")?.trim();
      return uuid ? encodeUuidSegment(uuid) : null;
    } catch {
      return null;
    }
  }

  // Numeric meeting ID, with or without the display spacing.
  const digits = input.replace(/\s+/g, "");
  if (/^\d{9,15}$/.test(digits)) return digits;

  // Bare meeting UUID (base64: 20-ish chars, usually "=="-terminated).
  if (/^[A-Za-z0-9+/=]{16,64}$/.test(input) && /[^0-9]/.test(input)) {
    return encodeUuidSegment(input);
  }
  return null;
}

function encodeUuidSegment(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(once) : once;
}

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
 * connected account's meetings. `meetingRef` is whatever the owner pasted —
 * numeric ID, UUID, or recording link (see normalizeZoomMeetingRef). Never
 * throws — every failure returns a typed, owner-presentable result.
 */
export async function fetchZoomMeetingTranscript(
  businessId: string,
  meetingRef: string,
  deps: TranscriptDeps = {}
): Promise<ZoomTranscriptResult> {
  const getToken = deps.getToken ?? getZoomAccessToken;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const segment = normalizeZoomMeetingRef(meetingRef);
  if (!segment) {
    return {
      ok: false,
      error: "not_found",
      detail:
        "Could not read that meeting reference — paste the meeting ID, the meeting UUID, or the recording page link from the Zoom portal."
    };
  }

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
      `${ZOOM_API_BASE_URL}/meetings/${segment}/transcript`,
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
    // Zoom quirk: for instant/ended meetings the numeric ID often 404s
    // (code 3322) even though the portal shows a transcript — only the
    // past-meeting instance UUID resolves. Steer the owner to the link.
    return {
      ok: false,
      error: "not_found",
      detail:
        "Zoom has no transcript under that reference. Make sure the meeting was cloud-recorded with audio transcript on (processing can take a few minutes) — and if it was, paste the recording page LINK from the Zoom portal (Recordings & Transcripts → your meeting) instead of the meeting ID."
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
