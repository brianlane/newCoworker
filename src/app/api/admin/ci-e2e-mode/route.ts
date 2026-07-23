/**
 * Admin toggle for the CI live-e2e mode (Admin → Gemini card).
 *
 * GET → current mode ("per-change" | "nightly-only").
 * PUT → set it. Takes effect on the NEXT CI run — the e2e job's spend
 *       guard consults GET /api/public/ci-e2e-mode at the start of every
 *       run, so no deploy or workflow edit is needed.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { CI_E2E_MODES, getCiE2eMode, setCiE2eMode } from "@/lib/admin/ci-e2e-mode";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
    return successResponse({ mode: await getCiE2eMode() });
  } catch (err) {
    return handleRouteError(err);
  }
}

const putSchema = z.object({ mode: z.enum(CI_E2E_MODES) });

export async function PUT(request: Request): Promise<Response> {
  try {
    await requireAdmin();
    const body = putSchema.parse(await request.json());
    await setCiE2eMode(body.mode);
    return successResponse({ mode: await getCiE2eMode() });
  } catch (err) {
    return handleRouteError(err);
  }
}
