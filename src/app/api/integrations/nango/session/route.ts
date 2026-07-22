import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getNangoClient } from "@/lib/nango/server";
import {
  WorkspaceConnectionCapError,
  assertWorkspaceConnectionAllowed
} from "@/lib/nango/connection-cap";
import { z } from "zod";

const bodySchema = z.object({
  businessId: z.string().uuid()
});

type ConnectSessionApiResponse = {
  data?: { token: string; connect_link?: string; expires_at?: string };
  token?: string;
};

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user?.email) {
      return errorResponse("UNAUTHORIZED", "Authentication required");
    }

    if (!process.env.NANGO_SECRET_KEY) {
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        "Workspace connections are not available (service misconfigured)",
        503
      );
    }

    const { businessId } = bodySchema.parse(await request.json());
    await requireBusinessRole(businessId, "manage_settings");

    // Tier cap — refuse BEFORE a connect session is even minted, so the
    // owner never walks an OAuth flow whose result would be rejected.
    await assertWorkspaceConnectionAllowed(businessId);

    const nango = getNangoClient();

    const sessionBody = {
      end_user: {
        id: businessId,
        email: user.email,
        display_name: user.email
      }
    };

    const raw = (await nango.createConnectSession(sessionBody)) as ConnectSessionApiResponse;
    const token = raw.data?.token ?? raw.token;
    if (!token) {
      console.error("createConnectSession: unexpected response shape", raw);
      return errorResponse("INTERNAL_SERVER_ERROR", "Failed to start connection");
    }

    return successResponse({ token });
  } catch (err) {
    if (err instanceof WorkspaceConnectionCapError) {
      return errorResponse("FORBIDDEN", err.message, 403);
    }
    return handleRouteError(err);
  }
}
