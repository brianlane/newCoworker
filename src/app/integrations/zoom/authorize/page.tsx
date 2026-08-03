import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { resolveActiveBusinessContext } from "@/lib/dashboard/active-business";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

/**
 * The Zoom Marketplace "Direct Landing URL" (App Listing -> Adding Your App
 * -> From your Site). Zoom requires a single URL that routes a SIGNED-IN user
 * to a page where they can authorize the integration, and bounces everyone
 * else to sign-in first.
 *
 * It exists as its own route rather than pointing Zoom at
 * /dashboard/integrations/zoom because the dashboard layout's unauthenticated
 * redirect is a fixed "/login?redirectTo=/dashboard" (a server layout has no
 * reliable access to the current pathname, and this repo runs no middleware),
 * so a logged-out visitor would land on the dashboard root having lost the
 * Zoom deep link entirely. Here the return path is a literal.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Authorize Zoom",
  // Reachable only from the Marketplace listing, not a marketing surface.
  robots: { index: false, follow: false }
};

const RETURN_PATH = "/integrations/zoom/authorize";

export default async function ZoomAuthorizePage() {
  const user = await getAuthUser();
  if (!user) redirect(`/login?redirectTo=${encodeURIComponent(RETURN_PATH)}`);

  const { businessId, accessible } = await resolveActiveBusinessContext(user);
  // `businessId` can be an admin view-as pin that is not in `accessible`, so
  // the active workspace is folded in rather than assumed present.
  const activeName = accessible.find((b) => b.businessId === businessId)?.name ?? null;
  const choices =
    businessId && activeName === null
      ? [{ businessId, name: "Current workspace" }, ...accessible]
      : accessible;

  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <section className="mx-auto max-w-2xl px-6 pb-24 pt-16">
        <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-signal-teal">
          Zoom integration
        </p>
        <h1 className="text-4xl font-bold leading-tight tracking-tight text-parchment">
          Authorize Zoom for your workspace
        </h1>
        <p className="mt-4 text-parchment/60">
          Connecting Zoom lets your AI coworker schedule Zoom meetings for the appointments it
          books, send customers the join link, and turn a cloud-recorded meeting&apos;s transcript
          into meeting minutes. You can disconnect at any time from your dashboard.
        </p>

        {businessId ? (
          <div className="mt-10 rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-6">
            {choices.length > 1 ? (
              <>
                {/* More than one workspace: never pick silently. The active
                    one is only a cookie, so authorizing it by default would
                    connect Zoom to a workspace the user did not choose. */}
                <p className="text-sm text-parchment/60">
                  This login has access to more than one workspace. Choose which one to connect
                  Zoom to.
                </p>
                <ul className="mt-4 space-y-2">
                  {choices.map((b) => (
                    <li
                      key={b.businessId}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-parchment/10 px-4 py-3"
                    >
                      <span className="text-parchment">
                        {b.name}
                        {b.businessId === businessId ? (
                          <span className="ml-2 text-xs text-parchment/40">(current)</span>
                        ) : null}
                      </span>
                      <a
                        href={`/api/integrations/zoom/connect?businessId=${encodeURIComponent(b.businessId)}`}
                        className="inline-flex items-center rounded-lg bg-claw-green px-4 py-2 text-sm font-semibold text-deep-ink transition hover:opacity-90"
                      >
                        Authorize Zoom
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <p className="text-sm text-parchment/60">
                  Authorizing for{" "}
                  <b className="text-parchment">{activeName ?? "your workspace"}</b>.
                </p>
                <a
                  href={`/api/integrations/zoom/connect?businessId=${encodeURIComponent(businessId)}`}
                  className="mt-4 inline-flex items-center rounded-xl bg-claw-green px-5 py-3 font-semibold text-deep-ink transition hover:opacity-90"
                >
                  Authorize Zoom
                </a>
              </>
            )}
            <p className="mt-4 text-sm text-parchment/50">
              Already connected, or want to change it later?{" "}
              <Link
                href="/dashboard/integrations/zoom"
                className="text-claw-green hover:underline"
              >
                Manage the connection
              </Link>
              .
            </p>
          </div>
        ) : (
          <div className="mt-10 rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-6">
            <p className="text-sm text-parchment/60">
              This login does not have a workspace yet. Zoom connects to a New Coworker business,
              so set one up first and then come back to this page.
            </p>
            <Link
              href="/onboard"
              className="mt-4 inline-flex items-center rounded-xl bg-claw-green px-5 py-3 font-semibold text-deep-ink transition hover:opacity-90"
            >
              Set up your workspace
            </Link>
          </div>
        )}

        <p className="mt-8 text-sm text-parchment/50">
          What the integration does, and how to remove it:{" "}
          <Link href="/integrations/zoom" className="text-claw-green hover:underline">
            newcoworker.com/integrations/zoom
          </Link>
          .
        </p>
      </section>

      <MarketingFooter />
    </div>
  );
}
