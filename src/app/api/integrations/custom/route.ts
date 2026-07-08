/**
 * Owner-facing CRUD for `custom_integrations` (list + create).
 *
 * The dashboard "Custom integrations" section (Card on /dashboard/
 * integrations) renders the list returned here and POSTs new rows
 * through the same endpoint. Item-level routes for read/update/delete
 * live at `./[id]/route.ts`.
 *
 * Auth: owner-only (Supabase session). RLS on the table itself enforces
 * the same boundary, but we still call `requireBusinessRole` so a missing
 * session 401s before we touch the DB.
 *
 * Why we don't accept the Rowboat gateway token here: this surface is
 * for management of the credential vault. The agent never lists or
 * mutates rows — it only invokes the proxy at `./call/route.ts` with a
 * label, and the proxy decrypts the matching row. Keeping write-paths
 * owner-only means even a compromised gateway token can't enumerate or
 * exfiltrate the stored credentials.
 */
import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  errorResponse,
  handleRouteError,
  successResponse
} from "@/lib/api-response";
import {
  CUSTOM_AUTH_SCHEMES,
  CustomIntegrationValidationError,
  createCustomIntegration,
  listCustomIntegrations
} from "@/lib/db/custom-integrations";

const businessIdSchema = z.string().uuid();

const createSchema = z.object({
  businessId: z.string().uuid(),
  label: z.string().min(1).max(80),
  baseUrl: z.string().url(),
  authScheme: z.enum(CUSTOM_AUTH_SCHEMES),
  headerName: z.string().min(1).max(128).optional().nullable(),
  // Cleartext on the wire (TLS) — encrypted before write. Length-bounded
  // so a runaway client can't OOM the encrypter; 4 KB covers every API
  // key / basic credential we've actually seen.
  secret: z.string().max(4096).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  isActive: z.boolean().optional()
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }
    const url = new URL(request.url);
    const businessId = url.searchParams.get("businessId");
    const parsed = businessIdSchema.safeParse(businessId);
    if (!parsed.success) {
      return errorResponse("VALIDATION_ERROR", "businessId is required");
    }
    if (!user.isAdmin) {
      await requireBusinessRole(parsed.data, "manage_settings");
    }
    const rows = await listCustomIntegrations(parsed.data);
    return successResponse(rows);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }
    const body = createSchema.parse(await request.json());
    if (!user.isAdmin) {
      await requireBusinessRole(body.businessId, "manage_settings");
    }
    const row = await createCustomIntegration(body);
    return successResponse(row, 201);
  } catch (err) {
    if (err instanceof CustomIntegrationValidationError) {
      return errorResponse("VALIDATION_ERROR", err.message);
    }
    if (
      err instanceof Error &&
      /duplicate key|unique constraint/i.test(err.message)
    ) {
      return errorResponse(
        "CONFLICT",
        "A custom integration with this label already exists"
      );
    }
    return handleRouteError(err);
  }
}
