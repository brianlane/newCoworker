/**
 * Microsoft Teams (Bot Framework) activity receiver.
 *
 * ONE URL for every tenant, unlike Telegram's per-connection path. That is
 * safe here because the activity is signed: `verifyTeamsToken` checks the
 * signature against Microsoft's JWKS, the issuer, the audience (our own app
 * id) and the expiry before anything else happens. The tenant is then read
 * from the verified activity, never from the URL.
 *
 * Status codes matter. Bot Framework retries a 5xx and gives up on a 4xx, so
 * an authentic activity we do nothing with answers 200, an unauthenticated
 * one answers 401 and stays gone, and a message we genuinely failed to store
 * answers 500 so it comes back.
 */

import { after, NextResponse } from "next/server";
import { getCoworkerConnectionByWorkspaceForChannel } from "@/lib/db/coworker-connections";
import { verifyTeamsToken } from "@/lib/teams/auth";
import { handleTeamsActivity, type TeamsActivity } from "@/lib/teams/inbound";
import { kickCoworkerWorker } from "@/lib/coworker-channels/kick";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Activities are small; anything larger is not one of ours. */
const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request) {
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }

  const verdict = await verifyTeamsToken(request.headers.get("authorization"));
  if (!verdict.ok) {
    if (verdict.reason === "jwks_unavailable") {
      // OUR failure, not the caller's. A 401 would look like a rejected
      // activity and never come back; a 500 makes Microsoft redeliver.
      return NextResponse.json({ ok: false, error: "key_fetch_failed" }, { status: 500 });
    }
    // Every other reason answers identically: telling an unauthenticated
    // caller WHICH check they failed is a free oracle.
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let activity: TeamsActivity;
  try {
    activity = JSON.parse(raw) as TeamsActivity;
  } catch {
    return NextResponse.json({ ok: true, skipped: "unparseable" });
  }

  // The tenant comes from the VERIFIED token where the token carries one,
  // and falls back to the activity's channelData. Activities reach us from
  // any Entra tenant that has installed the Teams app, so an unbound tenant
  // belongs to nobody and is dropped rather than guessed at.
  const tenantId = verdict.claims.tenantId ?? activity.channelData?.tenant?.id?.trim() ?? "";
  if (!tenantId) return NextResponse.json({ ok: true, skipped: "no_tenant" });

  let connection;
  try {
    connection = await getCoworkerConnectionByWorkspaceForChannel("teams", tenantId);
  } catch (err) {
    logger.error("teams webhook: connection read failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return NextResponse.json({ ok: false, error: "read_failed" }, { status: 500 });
  }
  // Authentic but not ours: 200, because Microsoft should stop retrying and
  // the sender learns nothing either way.
  if (!connection) return NextResponse.json({ ok: true, skipped: "unbound_tenant" });
  if (!connection.is_active) return NextResponse.json({ ok: true, skipped: "inactive" });

  try {
    const result = await handleTeamsActivity({ connection, activity });
    if (result.enqueued) after(() => kickCoworkerWorker("teams"));
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    logger.error("teams webhook: handler failed", {
      businessId: connection.business_id,
      error: err instanceof Error ? err.message : String(err)
    });
    return NextResponse.json({ ok: false, error: "handler_failed" }, { status: 500 });
  }
}
