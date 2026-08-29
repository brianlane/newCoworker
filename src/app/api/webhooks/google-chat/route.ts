/**
 * Google Chat event receiver.
 *
 * ONE URL for every tenant, like Teams and unlike Telegram's per-connection
 * path. That is safe because the event is signed: `verifyGoogleChatToken`
 * checks the signature against Google's published key set, the issuer, the
 * audience (our own Chat app's configured audience) and the expiry before
 * anything else happens. The space is then read from the verified event.
 *
 * THE REPLY IS THE RESPONSE BODY. Chat posts whatever JSON the webhook
 * returns, which is why an unbound space can be answered at all: telling a
 * stranger how to connect needs no credential and no connection row. The
 * queued turn still goes out through the API later, because a model call
 * does not fit in an ack window.
 *
 * A space with no connection is NOT an error here, unlike an unbound Slack
 * team or Entra tenant. A connect code is what binds a space, so the first
 * message from an unknown one is the beginning of setup.
 */

import { after, NextResponse } from "next/server";
import { getCoworkerConnectionByWorkspaceForChannel } from "@/lib/db/coworker-connections";
import { verifyGoogleChatToken } from "@/lib/google-chat/auth";
import { handleGoogleChatEvent, type GoogleChatEvent } from "@/lib/google-chat/inbound";
import { kickCoworkerWorker } from "@/lib/coworker-channels/kick";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Events are small; anything larger is not one of ours. */
const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request) {
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  const verdict = await verifyGoogleChatToken(request.headers.get("authorization"));
  if (!verdict.ok) {
    if (verdict.reason === "jwks_unavailable") {
      // OUR failure, not the caller's. A 401 would look like a rejected
      // event and never come back; a 500 makes Google redeliver.
      return NextResponse.json({ error: "key_fetch_failed" }, { status: 500 });
    }
    // Every other reason answers identically: telling an unauthenticated
    // caller WHICH check they failed is a free oracle.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let event: GoogleChatEvent;
  try {
    event = JSON.parse(raw) as GoogleChatEvent;
  } catch {
    return NextResponse.json({});
  }

  const space = (event.space?.name ?? event.message?.space?.name ?? "").trim();
  let connection = null;
  if (space) {
    try {
      connection = await getCoworkerConnectionByWorkspaceForChannel("google_chat", space);
    } catch (err) {
      logger.error("google chat webhook: connection read failed", {
        error: err instanceof Error ? err.message : String(err)
      });
      return NextResponse.json({ error: "read_failed" }, { status: 500 });
    }
  }
  // A paused connection is silence rather than a refusal: the owner turned
  // it off, and answering "you are not connected" would invite them to
  // spend a code re-binding a space that is already bound to them.
  if (connection && !connection.is_active) return NextResponse.json({});

  try {
    const result = await handleGoogleChatEvent({ connection, event });
    if (result.enqueued) after(() => kickCoworkerWorker("google_chat"));
    // Chat posts `text` into the space when there is one, and nothing at
    // all for an empty object.
    return NextResponse.json(result.reply ? { text: result.reply } : {});
  } catch (err) {
    logger.error("google chat webhook: handler failed", {
      businessId: connection?.business_id,
      error: err instanceof Error ? err.message : String(err)
    });
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}
