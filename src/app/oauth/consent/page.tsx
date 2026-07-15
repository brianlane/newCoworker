/**
 * OAuth 2.1 consent screen (Supabase Auth authorization path).
 *
 * When an OAuth client (e.g. Claude adding the New Coworker connector)
 * starts the authorization flow, Supabase Auth redirects the user here
 * with `?authorization_id=…`. The page requires a signed-in session
 * (redirecting to /login with the full consent URL preserved), loads the
 * authorization details, and posts the Approve/Deny decision to
 * /api/oauth/decision, which redirects back to the client.
 */

import Image from "next/image";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";

export const dynamic = "force-dynamic";

function ConsentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-deep-ink px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-3">
          <Image
            src="/logo.png"
            alt="New Coworker"
            width={56}
            height={56}
            className="rounded-full"
          />
          <h1 className="text-2xl font-bold text-parchment">Authorize access</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

export default async function OAuthConsentPage({
  searchParams
}: {
  searchParams: Promise<{ authorization_id?: string }>;
}) {
  const authorizationId = (await searchParams).authorization_id?.trim() ?? "";
  if (!authorizationId) {
    return (
      <ConsentShell>
        <Card>
          <p className="text-sm text-spark-orange">
            Missing authorization request. Start the connection again from the app you are
            authorizing.
          </p>
        </Card>
      </ConsentShell>
    );
  }

  const user = await getAuthUser();
  if (!user) {
    const next = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
    redirect(`/login?redirectTo=${encodeURIComponent(next)}`);
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);

  if (error || !data) {
    return (
      <ConsentShell>
        <Card>
          <p className="text-sm text-spark-orange">
            This authorization request is invalid or has expired
            {error?.message ? ` (${error.message})` : ""}. Start the connection again from the
            app you are authorizing.
          </p>
        </Card>
      </ConsentShell>
    );
  }

  // Already-consented requests return only a redirect_url — send the user
  // straight back to the client with their authorization code.
  if (!("authorization_id" in data)) {
    redirect(data.redirect_url);
  }

  const scopes = (data.scope ?? "").split(" ").filter((s) => s.trim().length > 0);

  return (
    <ConsentShell>
      <Card>
        <div className="space-y-4">
          <p className="text-sm text-parchment/80">
            <span className="font-semibold text-parchment">{data.client.name}</span> wants to
            access your New Coworker account
            {user!.email ? (
              <>
                {" "}
                as <span className="font-medium text-parchment">{user!.email}</span>
              </>
            ) : null}
            .
          </p>
          <p className="text-xs text-parchment/50">
            It will be able to act with your role on your businesses — reading contacts,
            messages and calls, sending texts, booking appointments, and managing AiFlows —
            until you disconnect it.
          </p>
          {scopes.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-parchment/60 uppercase tracking-wider">
                Requested permissions
              </p>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {scopes.map((scope) => (
                  <li
                    key={scope}
                    className="text-[11px] text-parchment/70 border border-parchment/15 rounded px-1.5 py-0.5"
                  >
                    {scope}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <form action="/api/oauth/decision" method="POST" className="flex gap-2 pt-1">
            <input type="hidden" name="authorization_id" value={authorizationId} />
            <button
              type="submit"
              name="decision"
              value="approve"
              className="flex-1 rounded-md bg-signal-teal px-4 py-2 text-sm font-medium text-deep-ink hover:opacity-90"
            >
              Approve
            </button>
            <button
              type="submit"
              name="decision"
              value="deny"
              className="flex-1 rounded-md border border-parchment/20 px-4 py-2 text-sm font-medium text-parchment/80 hover:bg-parchment/5"
            >
              Deny
            </button>
          </form>
        </div>
      </Card>
    </ConsentShell>
  );
}
