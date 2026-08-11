import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { workspaceProxyForBusiness } from "@/lib/workspace/proxy";
import { extractBearerToken, verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  connectionId: z.string().min(1),
  providerConfigKey: z.string().min(1),
  endpoint: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  data: z.unknown().optional(),
  headers: z.record(z.string(), z.string()).optional()
});

export async function POST(request: Request) {
  try {
    // Deliberately NO NANGO_SECRET_KEY pre-gate. Workspace connections are no
    // longer all Nango: a first-party Outlook connection needs no Nango key at
    // all, and refusing the whole route without one would 503 a perfectly good
    // direct connection. The dispatcher decides per row, and the Nango branch
    // still throws a clear error from getNangoClient when the key is missing.
    const user = await getAuthUser();
    const hasBearer = extractBearerToken(request) !== "";

    if (!user?.email && !hasBearer) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const body = bodySchema.parse(await request.json());

    if (user?.email) {
      await requireBusinessRole(body.businessId, "manage_settings");
    } else {
      // Gateway (VPS/Rowboat) path: the presented bearer must resolve to the
      // body's businessId (per-tenant token), so a leaked tenant token can't
      // proxy another tenant's Nango connection. Falls back to the shared
      // ROWBOAT_GATEWAY_TOKEN for boxes not yet on a per-tenant token. This is
      // the single authoritative gateway check — there is no shared-only
      // pre-gate that would 401 a tenant's own unique token first.
      const bound = await verifyGatewayTokenForBusiness(request, body.businessId);
      if (!bound) {
        return errorResponse("UNAUTHORIZED", "Token not valid for this business", 401);
      }
    }

    return await runProxy(body);
  } catch (err) {
    return handleRouteError(err);
  }
}

async function runProxy(parsed: z.infer<typeof bodySchema>) {
  const res = await workspaceProxyForBusiness(
    parsed.businessId,
    {
      connectionId: parsed.connectionId,
      providerConfigKey: parsed.providerConfigKey
    },
    {
      endpoint: parsed.endpoint,
      method: parsed.method,
      data: parsed.data,
      headers: parsed.headers
    }
  );

  if (!res) {
    return errorResponse("NOT_FOUND", "No workspace connection for this business");
  }

  return successResponse({
    status: res.status,
    data: res.data
  });
}
