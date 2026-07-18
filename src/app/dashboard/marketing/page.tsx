/**
 * Marketing page: a lead-sources snapshot (where new contacts come from,
 * what needs review) on top of email campaigns to a tag-filtered audience
 * plus the content calendar (campaigns grouped by month). Server component
 * resolves the business and the panel reads; the client component owns
 * composing/scheduling.
 */

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getMetaConnection } from "@/lib/db/meta-connections";
import { listSystemLogs } from "@/lib/db/system-logs";
import { countContactsTagged } from "@/lib/campaigns/audience";
import { listSocialPosts, type SocialPostRow } from "@/lib/social/db";
import { INSTAGRAM_PROSPECT_TAG } from "@/lib/ai-flows/templates";
import { Card } from "@/components/ui/Card";
import {
  CampaignsManager,
  type CalendarExtraItem
} from "@/components/dashboard/CampaignsManager";
import { SocialPostsManager } from "@/components/dashboard/SocialPostsManager";

export const dynamic = "force-dynamic";

const WEBHOOK_WINDOW_DAYS = 7;
/** Newest-first fetch bound for the panel's source summary. */
const WEBHOOK_SCAN_LIMIT = 500;

/**
 * Last-N-days webhook deliveries, counted by the caller-supplied source
 * label (facebook_lead_ads, instagram_scraper, …) so the owner sees which
 * pipes are actually flowing. Module-level (not in the component body): the
 * clock read is impure and this is a server component, so the summarization
 * runs as plain data prep.
 *
 * `clipped`: the newest-first fetch filled its bound and even its OLDEST
 * row is still inside the window — more in-window deliveries exist beyond
 * the fetch, so the counts are floors. The panel renders them as "N+"
 * with a note instead of silently underreporting (a big backlog import
 * alone can exceed the bound).
 */
function summarizeWebhookSources(
  logs: Array<{ created_at: string; payload: Record<string, unknown> }>
): { counts: Array<[string, number]>; clipped: boolean } {
  const windowStart = Date.now() - WEBHOOK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const bySource = new Map<string, number>();
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const log of logs) {
    const at = Date.parse(log.created_at);
    if (at < oldestMs) oldestMs = at;
    if (at < windowStart) continue;
    const source = String(log.payload?.source_label ?? "webhook");
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
  }
  return {
    counts: [...bySource.entries()].sort((a, b) => b[1] - a[1]),
    clipped: logs.length >= WEBHOOK_SCAN_LIMIT && oldestMs >= windowStart
  };
}

/** Scheduled/publishing/published IG posts as unified-calendar rows. */
function socialCalendarExtras(posts: SocialPostRow[]): CalendarExtraItem[] {
  const rows: CalendarExtraItem[] = [];
  for (const p of posts) {
    const at = p.publish_at ?? p.published_at;
    if (!at || (p.status !== "scheduled" && p.status !== "publishing" && p.status !== "published")) {
      continue;
    }
    rows.push({
      id: p.id,
      label: p.caption.trim() ? p.caption.slice(0, 80) : "Instagram post",
      at,
      statusText:
        p.status === "published" ? "Published" : p.status === "publishing" ? "Publishing…" : "Scheduled",
      channel: "IG"
    });
  }
  return rows;
}

export default async function MarketingPage() {
  const t = await getTranslations("dashboard.pages");
  const user = await getAuthUser();
  if (!user?.email) redirect("/login?redirectTo=/dashboard/marketing");

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;

  // Lead-sources panel + calendar reads, all best-effort: a failed read
  // renders the panel's empty state, never takes down the campaigns surface.
  const [metaConnection, webhookLogs, reviewCount, socialPosts] = business
    ? await Promise.all([
        getMetaConnection(business.id, db).catch(() => null),
        listSystemLogs(
          business.id,
          { source: "aiflow", search: "webhook_event_received", limit: WEBHOOK_SCAN_LIMIT },
          db
        ).catch(() => []),
        countContactsTagged(business.id, INSTAGRAM_PROSPECT_TAG, db).catch(() => 0),
        listSocialPosts(business.id, db).catch(() => [] as SocialPostRow[])
      ])
    : [null, [], 0, []];

  const metaActive = metaConnection?.status === "active" && metaConnection.is_active;
  const igConnected = metaActive && Boolean(metaConnection?.instagram_account_id);
  const { counts: sourceCounts, clipped: sourcesClipped } = summarizeWebhookSources(webhookLogs);

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-parchment">{t("marketingTitle")}</h1>
          <p className="text-sm text-parchment/50 mt-1">
            {t("marketingSubtitle")}
          </p>
        </div>
        {business ? (
          <div className="flex flex-wrap items-center gap-4 text-sm sm:shrink-0 sm:flex-nowrap sm:whitespace-nowrap">
            <Link
              href="/dashboard/aiflows/guides/meta-leads"
              className="text-signal-teal hover:underline"
            >
              Capture Meta ad leads
            </Link>
            <Link
              href="/dashboard/aiflows/guides/instagram-leads"
              className="text-signal-teal hover:underline"
            >
              Import Instagram prospects
            </Link>
          </div>
        ) : null}
      </div>
      {business ? (
        <>
          <Card>
            <h2 className="text-sm font-semibold text-parchment mb-3">Lead sources</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-parchment/40">
                  Meta Lead Ads
                </p>
                <p className="mt-1 text-sm">
                  {metaActive ? (
                    <span className="text-claw-green">
                      Connected{metaConnection?.page_name ? ` — ${metaConnection.page_name}` : ""}
                    </span>
                  ) : (
                    <span className="text-parchment/60">Not connected</span>
                  )}
                </p>
                <Link
                  href={
                    metaActive
                      ? "/dashboard/integrations/meta"
                      : "/dashboard/aiflows/guides/meta-leads"
                  }
                  className="mt-1 inline-block text-xs text-signal-teal hover:underline"
                >
                  {metaActive ? "Manage →" : "Set up lead capture →"}
                </Link>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-parchment/40">
                  Webhook leads ({WEBHOOK_WINDOW_DAYS} days)
                </p>
                {sourceCounts.length === 0 ? (
                  <p className="mt-1 text-sm text-parchment/60">No deliveries yet</p>
                ) : (
                  <>
                    <ul className="mt-1 space-y-0.5 text-sm text-parchment/80">
                      {sourceCounts.slice(0, 4).map(([source, count]) => (
                        <li key={source} className="flex items-baseline gap-2">
                          <span className="truncate font-mono text-xs text-parchment/60">
                            {source}
                          </span>
                          <span>
                            {count.toLocaleString()}
                            {sourcesClipped ? "+" : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {sourcesClipped ? (
                      <p className="mt-1 text-[11px] text-parchment/45">
                        Busy week — counting the most recent {WEBHOOK_SCAN_LIMIT} deliveries,
                        so these are at-least numbers.
                      </p>
                    ) : null}
                  </>
                )}
                <Link
                  href="/dashboard/aiflows/guides/instagram-leads"
                  className="mt-1 inline-block text-xs text-signal-teal hover:underline"
                >
                  Connect a lead source →
                </Link>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-parchment/40">
                  Pending review
                </p>
                <p className="mt-1 text-sm">
                  {reviewCount > 0 ? (
                    <span className="text-spark-orange">
                      {reviewCount.toLocaleString()} Instagram prospect
                      {reviewCount === 1 ? "" : "s"}
                    </span>
                  ) : (
                    <span className="text-parchment/60">Nothing waiting</span>
                  )}
                </p>
                {reviewCount > 0 ? (
                  <p className="text-[11px] text-parchment/45">
                    Scraped prospects — review before any outreach. Find them on the{" "}
                    <Link
                      href="/dashboard/customers"
                      className="text-signal-teal hover:underline"
                    >
                      Contacts page
                    </Link>{" "}
                    under the{" "}
                    <code className="font-mono text-[10px]">{INSTAGRAM_PROSPECT_TAG}</code>{" "}
                    tag.
                  </p>
                ) : null}
              </div>
            </div>
          </Card>
          <SocialPostsManager
            businessId={business.id}
            igConnected={igConnected}
            instagramUsername={metaConnection?.instagram_username ?? null}
          />
          <CampaignsManager
            businessId={business.id}
            calendarExtras={socialCalendarExtras(socialPosts)}
          />
        </>
      ) : (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60 mb-4">{t("noCoworker")}</p>
            <a
              href="/onboard"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
            >{t("getStarted")}</a>
          </div>
        </Card>
      )}
    </div>
  );
}
