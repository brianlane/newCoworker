/**
 * Internal Web Push delivery endpoint: the bridge the Deno notification
 * mirrors call.
 *
 * VAPID signing is ECDSA P-256 and the payload is aes128gcm content
 * encryption, both node:crypto, so the send path and the VAPID private key
 * live in src/lib and never reach an edge function. Exactly the
 * whatsapp-send / slack-send precedent.
 *
 * Bearer: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (assertCronAuth).
 *
 * POST { businessId, title, body, url?, notificationId?, tag? }
 * → 200 with the structured deliverPush result. `ok:false` outcomes are NOT
 *   HTTP errors: "not_connected" and "all_expired" are honest skips the
 *   caller records, not transport failures.
 */

import { z } from "zod";
import { assertCronAuth } from "@/lib/cron-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { deliverPush } from "@/lib/push/send";
import { notificationLink } from "@/lib/notifications/display";
import { getBusiness } from "@/lib/db/businesses";
import { notificationMustBePhiFree } from "../../../../../supabase/functions/_shared/hipaa_notification_redaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** null is the platform/HQ-admin scope. */
  businessId: z.string().uuid().nullable(),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(600),
  // Bounded because the service worker hands this to clients.openWindow.
  // buildPushPayload additionally forces it to stay app-relative.
  url: z.string().max(512).optional(),
  /**
   * The alert's kind and payload, so this route can resolve the tap target
   * itself when the caller has no explicit url.
   *
   * The Deno dispatcher cannot: `notificationLink` lives in src/lib and an
   * edge function cannot import it. Sending the two inputs instead of a
   * guessed path keeps ONE implementation of "where did this alert happen",
   * shared with the Node dispatcher and the dashboard's own notification
   * list, rather than a second one drifting in another runtime.
   */
  kind: z.string().max(64).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  notificationId: z.string().uuid().optional(),
  tag: z.string().max(64).optional()
});

export async function POST(request: Request): Promise<Response> {
  if (!assertCronAuth(request)) {
    return errorResponse("FORBIDDEN", "Invalid cron bearer", 403);
  }
  try {
    const body = bodySchema.parse(await request.json());
    /**
     * Second line of defence on the tap target.
     *
     * The caller is supposed to withhold `kind`/`payload` for a HIPAA tenant,
     * and the Deno dispatcher does. But a derived link can carry a patient
     * identifier straight into a payload bound for a third-party push vendor
     * (/dashboard/customers/%2B15551234567 IS the identifier), and that class
     * of mistake is a reportable breach rather than a bug. So the decision is
     * re-made here from the business row instead of trusted.
     *
     * Fails CLOSED by construction: getBusiness swallows its errors and
     * returns null, and notificationMustBePhiFree treats an unknown hipaa_mode
     * as "redact", so a read failure pins the link rather than deriving one.
     */
    let derived = "/dashboard";
    if (body.kind && !body.url) {
      const business = body.businessId ? await getBusiness(body.businessId) : null;
      const hipaaMode = business ? business.hipaa_mode === true : undefined;
      if (!notificationMustBePhiFree(hipaaMode)) {
        derived = notificationLink({ kind: body.kind, payload: body.payload ?? {} }).href;
      }
    }

    const result = await deliverPush({
      scope: { businessId: body.businessId },
      title: body.title,
      body: body.body,
      url: body.url ?? derived,
      notificationId: body.notificationId,
      tag: body.tag
    });
    return successResponse(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
