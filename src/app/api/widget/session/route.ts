/**
 * POST /api/widget/session — start a website-chat-widget visitor session.
 *
 * Cookie-free, CSRF-exempt (see src/proxy.ts): authenticated by the
 * tenant's public site key alone. Returns the one-time session bearer the
 * widget presents on every subsequent /message + /poll call.
 *
 * Body: { key: "ncw_pub_…", contact?: { name?, email?, phone? } }
 *
 * When the owner enabled the pre-chat contact form
 * (chat_widget_settings.require_contact_form), a session REQUIRES a name
 * plus at least one of email/phone — enforced server-side so a hand-rolled
 * client can't skip the form.
 */

import { z } from "zod";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitDurable, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import { mintWebchatSessionToken } from "@/lib/webchat/keys";
import { createWebchatSession } from "@/lib/webchat/db";
import { resolveWidgetContext } from "@/lib/webchat/service";
import { buildVisitorMeta, webchatClientMetaSchema } from "@/lib/webchat/visitor-meta";

export const dynamic = "force-dynamic";

// New sessions are cheap rows but each one is a fresh anonymous identity —
// keep a single IP from minting them in bulk. Durable (Postgres-backed) so
// the quota binds fleet-wide instead of per Vercel isolate (audit 2026-07,
// finding M3); it falls back to the in-memory limiter on any DB blip.
const SESSION_RATE = { interval: 10 * 60 * 1000, maxRequests: 20 };

const bodySchema = z.object({
  key: z.string().max(200),
  contact: z
    .object({
      name: z.string().trim().max(200).optional(),
      email: z.string().trim().email().max(320).optional(),
      phone: z.string().trim().max(32).optional()
    })
    .optional(),
  // Passive context the loader collected on the host page (page, referrer,
  // UTM, language, screen, timezone, returning, time-on-page). Untrusted;
  // a malformed blob must not block the chat, so it parses best-effort.
  meta: z.unknown().optional()
});

export async function POST(request: Request) {
  try {
    const ip = rateLimitIdentifierFromRequest(request);
    const limiter = await rateLimitDurable(`webchat-session:${ip}`, SESSION_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many chat sessions, please wait a moment.", 429);
    }

    const body = bodySchema.parse(await request.json());
    const ctx = await resolveWidgetContext({ key: body.key });
    if (!ctx.ok) {
      if (ctx.reason === "offline") {
        // 200 with an offline marker: the frame renders honest copy instead
        // of a generic failure (paused / Safe Mode is a normal tenant state).
        return successResponse({ status: "offline" });
      }
      return errorResponse("UNAUTHORIZED", "This chat widget is not available.");
    }

    const contact = body.contact ?? {};
    if (ctx.settings.require_contact_form) {
      const name = contact.name?.trim();
      const email = contact.email?.trim();
      const phone = contact.phone?.trim();
      if (!name || (!email && !phone)) {
        return errorResponse(
          "VALIDATION_ERROR",
          "Please provide your name and an email or phone number to start the chat."
        );
      }
    }

    // Passive visitor metadata: IP-derived coarse geo + device summary
    // (the IP itself is never stored) plus whatever valid client meta the
    // loader sent. Best-effort by design.
    const clientMeta = webchatClientMetaSchema.safeParse(body.meta ?? {});
    const visitorMeta = buildVisitorMeta({
      headers: request.headers,
      clientMeta: clientMeta.success ? clientMeta.data : null
    });

    const token = mintWebchatSessionToken();
    const session = await createWebchatSession(
      ctx.business.id,
      token.hash,
      {
        name: contact.name ?? null,
        email: contact.email ?? null,
        phone: contact.phone ?? null
      },
      visitorMeta
    );

    return successResponse({
      status: "ok",
      sessionId: session.id,
      // Shown once; the widget keeps it in sessionStorage. Only the sha256
      // is persisted server-side.
      sessionToken: token.plaintext
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
