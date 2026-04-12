import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { verifyRowboatGatewayToken } from "@/lib/rowboat/gateway-token";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid(),
  connectionId: z.string().min(1),
  providerConfigKey: z.string().min(1),
  endpoint: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  data: z.unknown().optional(),
  headers: z.record(z.string()).optional()
});

export async function POST(request: Request) {
  try {
    if (!process.env.NANGO_SECRET_KEY) {
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        "Workspace connections are not available (service misconfigured)",
        503
      );
    }

    const user = await getAuthUser();
    const gateway = verifyRowboatGatewayToken(request);

    if (!user?.email && !gateway) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    const body = bodySchema.parse(await request.json());

    if (user?.email) {
      await requireOwner(body.businessId);
    }

    return await runProxy(body);
  } catch (err) {
    return handleRouteError(err);
  }
}

async function runProxy(parsed: z.infer<typeof bodySchema>) {
  const res = await nangoProxyForBusiness(
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
