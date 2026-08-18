/**
 * Zoom meeting transcript fetch, the `cloud_recording:read:meeting_transcript`
 * scope added to the "New Coworker OAuth" Marketplace app (2026-07-17).
 *
 * `GET /meetings/{meetingId}/transcript` reports whether the cloud-recording
 * transcript can be downloaded (`can_download` + `download_url`, else a
 * `download_restriction_reason`); the VTT itself is then fetched from the
 * download URL with the same bearer token.
 *
 * First-party connections only, like every Zoom surface since the legacy
 * Nango transport was removed (Aug 2026).
 * Errors are typed for the owner-facing import flow, every failure mode
 * maps to an actionable message, never a bare 500.
 */
import { logger } from "@/lib/logger";
import { getZoomAccessToken } from "@/lib/zoom/client";
import { ZOOM_API_BASE_URL } from "@/lib/zoom/oauth";

/** Outbound budget per call, fail fast on a stuck upstream. */
export const ZOOM_TRANSCRIPT_TIMEOUT_MS = 20_000;

export type ZoomTranscriptError =
  /** No active direct Zoom connection, or the token lacks the transcript scope. */
  | "not_connected"
  /** Zoom has no transcript for this meeting id. */
  | "not_found"
  /** Transcript exists but Zoom refuses the download (restriction reason attached). */
  | "restricted"
  /** Transport/API failure, retryable. */
  | "request_failed";

export type ZoomTranscriptResult =
  | { ok: true; vtt: string }
  | { ok: false; error: ZoomTranscriptError; detail: string };

/**
 * Normalize an owner-pasted meeting reference into the path segment the
 * transcript endpoint accepts. Zoom's `GET /meetings/{id}/transcript`
 * resolves ONLY the past-meeting instance UUID for instant/ended meetings,
 * the numeric meeting id 404s (code 3322) even when the portal shows a
 * transcript, so owners can paste any of:
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

/**
 * The RAW (unencoded) meeting UUID from an owner-pasted reference, when the
 * reference carries one: a recording page link's `meeting_id` param or a
 * bare UUID. Numeric meeting IDs and unusable inputs return null. Used to
 * key the transcript-import dedupe ledger, which stores raw UUIDs (the
 * webhook payload's `object.uuid` is raw too).
 */
export function rawZoomMeetingUuid(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (!/(^|\.)zoom\.(us|com)$/i.test(url.hostname)) return null;
      const uuid = url.searchParams.get("meeting_id")?.trim();
      return uuid && uuid.length > 0 ? uuid : null;
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z0-9+/=]{16,64}$/.test(input) && /[^0-9]/.test(input)) return input;
  return null;
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

/** Topic / start time / ids from GET /past_meetings/{id}. */
export type ZoomPastMeetingMeta = {
  topic: string | null;
  /** ISO start time from Zoom, when present. */
  startTime: string | null;
  /** Numeric meeting id as a digit string, when present. */
  meetingId: string | null;
  /** Raw (unencoded) past-meeting instance UUID, when present. */
  uuid: string | null;
};

export type ZoomTranscriptTitleInput = {
  topic?: string | null;
  startTime?: string | null;
  meetingId?: string | null;
};

/**
 * Format a Zoom ISO start time as a short UTC calendar date for titles
 * ("Jul 29, 2026"). Null when the input is missing or unparseable.
 */
export function formatZoomMeetingDate(startTime: string | null | undefined): string | null {
  if (!startTime?.trim()) return null;
  const ms = Date.parse(startTime);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

/**
 * Document title for an imported Zoom transcript. Prefer Zoom's topic plus
 * the meeting date so instant meetings that share a default topic still
 * produce distinct library rows. Never emit a bare
 * "Zoom meeting recording (transcript)" when a date is known.
 */
export function buildZoomTranscriptTitle(input: ZoomTranscriptTitleInput): string {
  const topic = input.topic?.trim() || null;
  const meetingId =
    input.meetingId && /^\d{9,15}$/.test(input.meetingId.replace(/\s+/g, ""))
      ? input.meetingId.replace(/\s+/g, "")
      : null;
  const date = formatZoomMeetingDate(input.startTime ?? null);

  if (topic && date) return `${topic} · ${date} (transcript)`;
  if (topic) return `${topic} (transcript)`;
  if (meetingId && date) return `Zoom meeting ${meetingId} · ${date} (transcript)`;
  if (meetingId) return `Zoom meeting ${meetingId} (transcript)`;
  if (date) return `Zoom meeting · ${date} (transcript)`;
  return "Zoom meeting recording (transcript)";
}

/**
 * Filename-safe storage label: numeric meeting id when known, else a UTC
 * date stamp (2026-07-29), else the literal "recording".
 */
export function buildZoomTranscriptRefLabel(input: ZoomTranscriptTitleInput): string {
  const meetingId =
    input.meetingId && /^\d{9,15}$/.test(input.meetingId.replace(/\s+/g, ""))
      ? input.meetingId.replace(/\s+/g, "")
      : null;
  if (meetingId) return meetingId;
  if (input.startTime?.trim()) {
    const ms = Date.parse(input.startTime);
    if (!Number.isFinite(ms)) return "recording";
    return new Date(ms).toISOString().slice(0, 10);
  }
  return "recording";
}

/**
 * Fetch past-meeting details (topic, start_time, uuid, numeric id) via
 * GET /past_meetings/{meetingId} (`meeting:read:past_meeting`). Accepts a
 * numeric id, raw UUID, or any reference normalizeZoomMeetingRef understands.
 * FAIL-OPEN: null on any failure (pre-scope tokens, transport, missing body).
 */
export async function fetchPastMeetingMeta(
  businessId: string,
  meetingRef: string,
  deps: TranscriptDeps = {}
): Promise<ZoomPastMeetingMeta | null> {
  const getToken = deps.getToken ?? getZoomAccessToken;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const digits = meetingRef.trim().replace(/\s+/g, "");
  let segment: string | null = null;
  if (/^\d{9,15}$/.test(digits)) {
    segment = digits;
  } else {
    const rawUuid = rawZoomMeetingUuid(meetingRef);
    if (!rawUuid) return null;
    segment = encodeUuidSegment(rawUuid);
  }

  let token: string | null;
  try {
    token = await getToken(businessId);
  } catch {
    return null;
  }
  if (!token) return null;

  let res: Response;
  try {
    res = await timedFetch(
      fetchImpl,
      `${ZOOM_API_BASE_URL}/past_meetings/${segment}`,
      { Authorization: `Bearer ${token}`, Accept: "application/json" }
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const body = (await res.json().catch(() => null)) as {
    uuid?: unknown;
    topic?: unknown;
    start_time?: unknown;
    id?: unknown;
  } | null;
  if (!body) return null;

  const uuid =
    typeof body.uuid === "string" && body.uuid.trim().length > 0 ? body.uuid.trim() : null;
  const topic =
    typeof body.topic === "string" && body.topic.trim().length > 0 ? body.topic.trim() : null;
  const startTime =
    typeof body.start_time === "string" && body.start_time.trim().length > 0
      ? body.start_time.trim()
      : null;
  let meetingId: string | null = null;
  if (typeof body.id === "number" && Number.isFinite(body.id)) {
    meetingId = String(body.id);
  } else if (typeof body.id === "string") {
    const idDigits = body.id.replace(/\s+/g, "");
    if (/^\d{9,15}$/.test(idDigits)) meetingId = idDigits;
  }

  if (!uuid && !topic && !startTime && !meetingId) return null;
  return { topic, startTime, meetingId, uuid };
}

/**
 * Resolve a NUMERIC meeting id to its latest past-meeting instance UUID via
 * GET /past_meetings/{meetingId} (`meeting:read:past_meeting`, the scope
 * added in the Jul 2026 Marketplace update). FAIL-OPEN by design: tokens
 * minted before the scope shipped answer 401/403 here, and callers keep the
 * pre-scope behavior (numeric flow, no UUID). Null on ANY failure.
 */
export async function resolvePastMeetingUuid(
  businessId: string,
  numericMeetingId: string,
  deps: TranscriptDeps = {}
): Promise<string | null> {
  if (!/^\d{9,15}$/.test(numericMeetingId)) return null;
  const meta = await fetchPastMeetingMeta(businessId, numericMeetingId, deps);
  return meta?.uuid ?? null;
}

/**
 * Fetch the cloud-recording transcript (raw WebVTT text) for one of the
 * connected account's meetings. `meetingRef` is whatever the owner pasted,
 * numeric ID, UUID, or recording link (see normalizeZoomMeetingRef). Never
 * throws, every failure returns a typed, owner-presentable result.
 *
 * Zoom quirk closed in Jul 2026: a NUMERIC id often 404s for instant/ended
 * meetings (code 3322) even when a transcript exists, so on that 404 the
 * id is resolved to its past-meeting instance UUID (scope permitting) and
 * the lookup retried once through the UUID.
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
        "Could not read that meeting reference, paste the meeting ID, the meeting UUID, or the recording page link from the Zoom portal."
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
      detail: "Could not reach Zoom to refresh the connection, try again shortly."
    };
  }
  if (!token) {
    return {
      ok: false,
      error: "not_connected",
      detail: "No active Zoom connection, connect Zoom on the Integrations page first."
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
      detail: "Zoom did not respond, try again shortly."
    };
  }

  if (metaRes.status === 401 || metaRes.status === 403) {
    // Insufficient scope or revoked token: connections made before the
    // transcript scope shipped don't carry it, reconnect re-consents.
    return {
      ok: false,
      error: "not_connected",
      detail:
        "Zoom rejected the request. Reconnect Zoom on the Integrations page to grant the meeting-transcript permission."
    };
  }
  if (metaRes.status === 404) {
    // Zoom quirk: for instant/ended meetings the numeric ID often 404s
    // (code 3322) even though the portal shows a transcript, only the
    // past-meeting instance UUID resolves. When the reference was numeric,
    // resolve it to the instance UUID and retry once through that path
    // (fail-open: without the past-meeting scope the resolver returns null
    // and the owner gets the steer-to-link copy, exactly as before).
    if (/^\d{9,15}$/.test(segment)) {
      const uuid = await resolvePastMeetingUuid(businessId, segment, deps);
      if (uuid) return fetchZoomMeetingTranscript(businessId, uuid, deps);
    }
    return {
      ok: false,
      error: "not_found",
      detail:
        "Zoom has no transcript under that reference. Make sure the meeting was cloud-recorded with audio transcript on (processing can take a few minutes), and if it was, paste the recording page LINK from the Zoom portal (Recordings & Transcripts → your meeting) instead of the meeting ID."
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
      detail: "The transcript download timed out, try again shortly."
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
    // A login page or error body instead of a transcript, refuse rather
    // than ingest garbage into the owner's document library.
    return {
      ok: false,
      error: "request_failed",
      detail: "Zoom returned something that isn't a VTT transcript, try again shortly."
    };
  }
  return { ok: true, vtt };
}
