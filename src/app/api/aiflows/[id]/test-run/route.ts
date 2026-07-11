/**
 * "Test with a contact" for an AiFlow (GHL's Test Workflow).
 *
 * Enqueues a run whose trigger scope is synthesized from a chosen contact
 * and flagged `test_mode: true`: the worker executes the real engine but
 * SIMULATES every side-effecting action (sends, routing, CRM writes,
 * approvals) and resolves waits instantly — the whole flow plays out on the
 * runs page in seconds, with each simulated step recording exactly what a
 * live run would have sent. See _shared/ai_flows/test_mode.ts.
 *
 * Unlike "Run now", the flow does NOT need to be enabled — testing a draft
 * before switching it on is the whole point — so the run is enqueued with
 * the trigger scope carrying the flag the worker's disabled-flow guard
 * checks (test runs of disabled flows are allowed to execute).
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { enqueueAiFlowRun, getAiFlow } from "@/lib/ai-flows/db";
import { getCustomerMemory } from "@/lib/customer-memory/db";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import { TEST_MODE_TRIGGER_KEY } from "../../../../../../supabase/functions/_shared/ai_flows/test_mode";

const idSchema = z.string().uuid();

const bodySchema = z.object({
  businessId: z.string().uuid(),
  /** The contact to run the test as (any phone shape the Add form accepts). */
  contactE164: z.string().min(3).max(40),
  /** Optional sample message text ({{trigger.windowText}}). */
  input: z.string().max(4000).optional()
});

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  try {
    const user = await getAuthUser();
    if (!user?.email) return errorResponse("UNAUTHORIZED", "Authentication required");
    const { id } = await params;
    if (!idSchema.safeParse(id).success) return errorResponse("VALIDATION_ERROR", "id is invalid");
    const body = bodySchema.parse(await request.json());
    if (!user.isAdmin) await requireBusinessRole(body.businessId, "manage_aiflows");

    const flow = await getAiFlow(body.businessId, id);
    if (!flow) return errorResponse("NOT_FOUND", "AiFlow not found");
    if (flow.definition?.trigger?.channel === "voice") {
      return errorResponse(
        "VALIDATION_ERROR",
        "Voice flows run on the live call path; place a call from the trigger number to test."
      );
    }

    // Coerce loose input ("(602) 555-1234") to the stored canonical shape
    // the same way the Add-customer form does, so a valid number never
    // misses its contact row over formatting.
    const normalized = normalizeContactNumber(body.contactE164);
    if (!normalized.ok) {
      return errorResponse("VALIDATION_ERROR", `contact phone: ${normalized.reason}`);
    }
    const contact = await getCustomerMemory(body.businessId, normalized.value);
    if (!contact) return errorResponse("NOT_FOUND", "Contact not found");

    // Synthesize the trigger the way an inbound SMS from this contact would
    // look, so extract_text / from-templates / wait phone-vars all resolve.
    const sample =
      body.input?.trim() ||
      [
        contact.display_name ? `name: ${contact.display_name}` : "",
        `phone: ${contact.customer_e164}`,
        contact.email ? `email: ${contact.email}` : ""
      ]
        .filter(Boolean)
        .join("\n");

    const run = await enqueueAiFlowRun({
      businessId: body.businessId,
      flowId: id,
      trigger: {
        channel: "manual",
        windowText: sample,
        url: null,
        from: contact.customer_e164,
        contact_name: contact.display_name ?? "",
        [TEST_MODE_TRIGGER_KEY]: true
      },
      // Every click is its own test; no drip stagger either (the caller is
      // watching the runs page for the result).
      dedupeKey: `test:${crypto.randomUUID()}`,
      earliestClaimAt: new Date().toISOString()
    });
    return successResponse(run);
  } catch (err) {
    return handleRouteError(err);
  }
}
