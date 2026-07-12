/**
 * Public signing endpoint: POST /api/public/sign/:token
 *
 * Body: { signatureName, consent }. The token is the whole capability
 * (256-bit, sha256-only at rest); every non-servable state — unknown/void/
 * expired token, expired or deleted document, already signed — fails closed
 * with the same shape the signing page can render. Rate-limited per IP so
 * the endpoint can't be brute-forced or spammed.
 */

import { z } from "zod";
import { signDocumentRequest } from "@/lib/documents/signing";
import { rateLimit, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  signatureName: z.string().min(1).max(200),
  consent: z.boolean()
});

type RouteContext = { params: Promise<{ token: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { token } = await context.params;
  if (!token || token.length > 200) {
    return Response.json({ ok: false, detail: "not_found" }, { status: 404 });
  }

  const limited = await rateLimit(`sign:${rateLimitIdentifierFromRequest(request)}`, {
    interval: 60_000,
    maxRequests: 10
  });
  if (!limited.success) {
    return Response.json({ ok: false, detail: "rate_limited" }, { status: 429 });
  }

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ ok: false, detail: "invalid_body" }, { status: 400 });
  }

  try {
    const result = await signDocumentRequest({
      token,
      signatureName: body.data.signatureName,
      consent: body.data.consent,
      signerIp: rateLimitIdentifierFromRequest(request),
      signerUserAgent: request.headers.get("user-agent") ?? ""
    });
    if (!result.ok) {
      // Signer-input problems are honest 400s (the page is already serving
      // this token, so nothing leaks).
      if (result.detail === "consent_required" || result.detail === "signature_name_required") {
        return Response.json(result, { status: 400 });
      }
      // `already_signed` stays distinct: a signed token already serves its
      // certificate page, so it reveals nothing new — and the form needs it
      // for honest copy.
      if (result.detail === "already_signed") {
        return Response.json(result, { status: 409 });
      }
      // Every other dead-token state collapses to the SAME 404 the signing
      // page and file route return, so callers can't distinguish unknown
      // tokens from valid-but-dead ones by probing this endpoint.
      return Response.json({ ok: false, detail: "not_found" }, { status: 404 });
    }
    return Response.json(result);
  } catch (err) {
    logger.warn("public/sign: signing failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return Response.json({ ok: false, detail: "internal_error" }, { status: 500 });
  }
}
