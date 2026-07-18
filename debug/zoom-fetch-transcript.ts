/**
 * One-shot: fetch a Zoom meeting's cloud-recording transcript (.vtt) through
 * the business's first-party Zoom connection (`zoom_connections`), using the
 * `cloud_recording:read:meeting_transcript` scope added to the "New Coworker
 * OAuth" Marketplace app on 2026-07-17.
 *
 * GET /meetings/{meetingId}/transcript → { can_download, download_url | 
 * download_restriction_reason }; when downloadable, the VTT is fetched with
 * the same bearer token and written to debug/.tmp-zoom-transcript-<id>.vtt
 * (gitignored via debug/.tmp-*).
 *
 * Usage:
 *   tsx debug/zoom-fetch-transcript.ts --meeting <meetingId> [--business <uuid>]
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
const meetingId = argValue("--meeting");
if (!meetingId) {
  console.error("Usage: tsx debug/zoom-fetch-transcript.ts --meeting <meetingId> [--business <uuid>]");
  process.exit(1);
}

const { getZoomAccessToken } = await import("../src/lib/zoom/client.ts");

const token = await getZoomAccessToken(businessId);
if (!token) {
  throw new Error(
    `business ${businessId} has no active direct Zoom connection — connect (or reconnect) on /dashboard/integrations first`
  );
}

const metaRes = await fetch(
  `https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}/transcript`,
  { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
);
const metaBody = await metaRes.text();
if (!metaRes.ok) {
  throw new Error(`transcript lookup failed (${metaRes.status}): ${metaBody.slice(0, 400)}`);
}
const meta = JSON.parse(metaBody) as {
  can_download?: boolean;
  download_url?: string;
  download_restriction_reason?: string;
};
console.log("transcript meta:", JSON.stringify(meta, null, 2));

if (!meta.can_download || !meta.download_url) {
  throw new Error(
    `transcript not downloadable: ${meta.download_restriction_reason ?? "no reason given"}`
  );
}

const dl = await fetch(meta.download_url, {
  headers: { Authorization: `Bearer ${token}` },
  redirect: "follow"
});
if (!dl.ok) throw new Error(`download failed (${dl.status})`);
const vtt = await dl.text();

const outPath = path.resolve(process.cwd(), `debug/.tmp-zoom-transcript-${meetingId}.vtt`);
fs.writeFileSync(outPath, vtt, "utf8");
console.log(`OK: wrote ${vtt.length} chars to ${outPath}`);
console.log(`preview:\n${vtt.slice(0, 500)}`);
