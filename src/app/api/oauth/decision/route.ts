/**
 * POST /api/oauth/decision — the consent page's Approve/Deny handler.
 *
 * Session-cookie authenticated (the browser form post from /oauth/consent;
 * CSRF origin checks apply normally). Approve/deny run against Supabase
 * Auth AS THE SIGNED-IN USER, then the browser is redirected back to the
 * OAuth client with the authorization code (or access_denied error).
 */

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "Sign in to continue" },
      { status: 401 }
    );
  }

  const formData = await request.formData().catch(() => null);
  const authorizationId = formData?.get("authorization_id");
  const decision = formData?.get("decision");
  if (typeof authorizationId !== "string" || !authorizationId.trim()) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Missing authorization_id" },
      { status: 400 }
    );
  }
  if (decision !== "approve" && decision !== "deny") {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "decision must be approve or deny" },
      { status: 400 }
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } =
    decision === "approve"
      ? await supabase.auth.oauth.approveAuthorization(authorizationId, {
          skipBrowserRedirect: true
        })
      : await supabase.auth.oauth.denyAuthorization(authorizationId, {
          skipBrowserRedirect: true
        });

  if (error || !data?.redirect_url) {
    return NextResponse.json(
      {
        error: "OAUTH_DECISION_FAILED",
        message: error?.message ?? "Could not record the decision — start the flow again."
      },
      { status: 400 }
    );
  }

  // 303: the browser arrived via form POST; the client callback must be GET.
  return NextResponse.redirect(data.redirect_url, { status: 303 });
}
