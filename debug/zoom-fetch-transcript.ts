/**
 * One-shot: fetch a Zoom meeting's cloud-recording transcript (.vtt) through
 * the business's first-party Zoom connection (`zoom_connections`), using the
 * `cloud_recording:read:meeting_transcript` scope added to the "New Coworker
 * OAuth" Marketplace app on 2026-07-17.
 *
 * Rides the same lib as the dashboard import (fetchZoomMeetingTranscript):
 * the --meeting value can be the numeric meeting ID, the meeting UUID, or
 * the recording page link — instant/ended meetings resolve ONLY by UUID
 * (Zoom 404s the numeric id with code 3322), so prefer the link. The VTT is
 * written to debug/.tmp-zoom-transcript-<label>.vtt (gitignored).
 *
 * Usage:
 *   tsx debug/zoom-fetch-transcript.ts --meeting <id|uuid|link> [--business <uuid>]
 *
 * Defaults to the New Coworker HQ internal tenant. Requires that business to
 * have an ACTIVE direct Zoom connection whose grant includes the transcript
 * scope (reconnect on /dashboard/integrations if the connection predates the
 * scope change — old tokens do NOT gain new scopes).
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./_shared.ts";

loadEnv();

const HQ_BIZ = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d"; // New Coworker HQ (internal)

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const businessId = argValue("--business") ?? HQ_BIZ;
const meetingRef = argValue("--meeting");
if (!meetingRef) {
  console.error(
    "Usage: tsx debug/zoom-fetch-transcript.ts --meeting <id|uuid|link> [--business <uuid>]"
  );
  process.exit(1);
}

const { fetchZoomMeetingTranscript } = await import("../src/lib/zoom/transcript.ts");

const result = await fetchZoomMeetingTranscript(businessId, meetingRef);
if (!result.ok) {
  throw new Error(`${result.error}: ${result.detail}`);
}

const digits = meetingRef.replace(/\s+/g, "");
const label = /^\d{9,15}$/.test(digits) ? digits : "recording";
const outPath = path.resolve(process.cwd(), `debug/.tmp-zoom-transcript-${label}.vtt`);
fs.writeFileSync(outPath, result.vtt, "utf8");
console.log(`OK: wrote ${result.vtt.length} chars to ${outPath}`);
console.log(`preview:\n${result.vtt.slice(0, 500)}`);
