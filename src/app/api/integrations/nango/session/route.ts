import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getNangoClient } from "@/lib/nango/server";
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
    await requireOwner(businessId);

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
    return handleRouteError(err);
  }
}
