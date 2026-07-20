import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import {
  getContactFormSinkBusinessId,
  setContactFormSink
} from "@/lib/db/contact-form-sink";
import { insertCoworkerLog } from "@/lib/db/logs";
import { logger } from "@/lib/logger";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  enabled: z.boolean()
});

/**
 * Admin toggle for the platform contact-form sink — the operator console
 * behind the "Contact form (platform)" card on the admin business page.
 *
 * When enabled, public /contact submissions ALSO enqueue a webhook-channel
 * AiFlow event (source "contact_form") for this business, so the internal
 * HQ coworker can triage them; the notification email to CONTACT_EMAIL is
 * unchanged either way. At most one business fleet-wide can be the sink
 * (partial unique index) — enabling here moves the designation. Audit-logged
 * to coworker_logs like the RCS toggle.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();

    const body = bodySchema.parse(await request.json());
    const business = await getBusiness(body.businessId);
    if (!business) return errorResponse("NOT_FOUND", "Business not found");

    const previousSinkBusinessId = await getContactFormSinkBusinessId();
    await setContactFormSink(body.businessId, body.enabled);

    try {
      await insertCoworkerLog({
        id: crypto.randomUUID(),
        business_id: body.businessId,
        task_type: "data_flow",
        status: "success",
        log_payload: {
          action: "contact_form_sink_updated",
          enabled: body.enabled,
          previousSinkBusinessId
        }
      });
    } catch (err) {
      // Audit logging is best-effort — the designation is already updated.
      logger.warn("contact-form-sink: audit log insert failed", {
        businessId: body.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    return successResponse({
      businessId: body.businessId,
      enabled: body.enabled,
      previousSinkBusinessId
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}
