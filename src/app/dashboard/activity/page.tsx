import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { resolveDashboardOwnerEmail } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  getActivityFeedPage,
  activityWindowDays,
  type ActivityFeedPage
} from "@/lib/db/activity";
import { Card } from "@/components/ui/Card";
import { ActivityList } from "@/components/dashboard/ActivityList";

export const dynamic = "force-dynamic";

/** Build a chunk URL from its cursor, the trail of prior cursors, and whether
 * the client list should open on its LAST page (used when stepping back from
 * an older chunk, so "Previous" lands adjacent to where the reader was). */
function chunkHref(before: string | undefined, trail: string[], atEnd: boolean): string {
  const q = new URLSearchParams();
  if (before) q.set("before", before);
  if (trail.length > 0) q.set("trail", trail.join(","));
  if (atEnd) q.set("at", "end");
  const qs = q.toString();
  return qs ? `/dashboard/activity?${qs}` : "/dashboard/activity";
}

export default async function ActivityPage(props: {
  searchParams?: Promise<{ before?: string; trail?: string; at?: string }>;
}) {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard/activity");
  if (!user.email) redirect("/login");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const ownerEmail = (await resolveDashboardOwnerEmail(user)) ?? user.email;

  const params = (await props.searchParams) ?? {};

  // Older-chunk cursor (a previous chunk's nextBefore). Anything that doesn't
  // parse as a date is ignored rather than passed into queries.
  const rawBefore = params.before;
  const before =
    rawBefore && !Number.isNaN(Date.parse(rawBefore)) ? rawBefore : undefined;

  // Cursors of the chunks walked through to get here (oldest hop first). The
  // chunk cursor is forward-only, so this trail is what lets "Previous" return
  // to the exact chunk the reader came from instead of jumping to the newest.
  const trail = (params.trail ?? "")
    .split(",")
    .filter((t) => t && !Number.isNaN(Date.parse(t)));
  const startAtEnd = params.at === "end";

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, tier")
    .eq("owner_email", ownerEmail)
    .order("created_at", { ascending: false })
    .limit(1);
  const businessId = businesses?.[0]?.id ?? null;
  const tier = businesses?.[0]?.tier ?? null;
  const windowDays = activityWindowDays(tier);

  let page: ActivityFeedPage = { items: [], nextBefore: null };
  if (businessId) {
    page = await getActivityFeedPage(businessId, { before, tier }, db).catch(() => ({
      items: [],
      nextBefore: null
    }));
  }

  // Next-older chunk: push the current cursor onto the trail. On the newest
  // chunk (no cursor) the trail is always restarted empty — a stray `trail`
  // param there would otherwise send "Previous" to the wrong chunk. Next-newer
  // chunk: pop the trail and open that chunk on its last client page.
  const olderHref = page.nextBefore
    ? chunkHref(page.nextBefore, before ? [...trail, before] : [], false)
    : null;
  const newerHref = before
    ? chunkHref(trail[trail.length - 1], trail.slice(0, -1), true)
    : null;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-parchment">All activity</h1>
          <p className="mt-1 text-sm text-parchment/50">
            Calls, texts, emails, dashboard chat, AiFlow runs, new customers, and alerts from the
            last {windowDays} days
            {before ? " (viewing older activity)" : ""}.
            {tier === "starter" && " Upgrade to Standard for 90 days of history."}
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-signal-teal hover:underline">
          ← Back to dashboard
        </Link>
      </div>

      {!businessId ? (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">No business found.</p>
        </Card>
      ) : (
        <ActivityList
          items={page.items}
          olderHref={olderHref}
          newerHref={newerHref}
          startAtEnd={startAtEnd}
        />
      )}
    </div>
  );
}
