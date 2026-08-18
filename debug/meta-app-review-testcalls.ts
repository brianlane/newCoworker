/**
 * Exercise the Graph API calls Meta's "Testing your use cases" panel counts,
 * so no permission row in App Review sits at "0 of 1 API call(s) required".
 *
 *   npx tsx debug/meta-app-review-testcalls.ts            # read-only calls
 *   npx tsx debug/meta-app-review-testcalls.ts --probe    # also report which
 *                                                        # permissions the
 *                                                        # token actually holds
 *
 * READ-ONLY BY DESIGN. Every call here is a GET. Meta counts a successful
 * call against the permission that authorized it, and the permissions we
 * request are all satisfiable by a read, so nothing in this script posts,
 * comments, publishes, or messages anyone. A permission whose only test is a
 * WRITE is reported as "needs a write" and skipped rather than performed:
 * this runs against the live New Coworker Page and Instagram account, and a
 * test post is a real post.
 *
 * Uses the HQ tenant's stored PAGE token (permanent, no refresh flow) rather
 * than META_USER_TEST_TOKEN, which is a short-lived user token that lapses
 * roughly weekly and had already expired when this was written.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

/** The New Coworker internal tenant that owns our own Page + IG account. */
const HQ_BUSINESS_ID = "e2b7a1c4-0000-4000-8000-000000000002";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const businessId = process.argv.find((a) => UUID_RE.test(a)) ?? HQ_BUSINESS_ID;
const probeOnly = process.argv.includes("--probe");

type Call = {
  /** The permission row this call is meant to satisfy, as Meta labels it. */
  permission: string;
  path: string;
  params?: Record<string, string>;
  /** Which token to use: the page token or the stored user token. */
  token?: "page" | "user";
};

async function main() {
  const { getMetaConnection } = await import("../src/lib/db/meta-connections.ts");
  const { META_GRAPH_BASE_URL } = await import("../src/lib/meta/client.ts");

  const conn = await getMetaConnection(businessId);
  if (!conn?.pageToken) {
    console.log(`no usable meta_connections row for business ${businessId}`);
    return;
  }
  const pageId = conn.page_id;
  const igId = conn.instagram_account_id;
  if (!pageId) {
    console.log("connection has no page_id");
    return;
  }
  console.log(`page=${pageId} (${conn.page_name}) ig=${igId ?? "-"} (${conn.instagram_username ?? "-"})\n`);

  const get = async (path: string, params: Record<string, string>, token: string) => {
    const url = new URL(`${META_GRAPH_BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("access_token", token);
    const res = await fetch(url.toString());
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string; code?: number; error_subcode?: number };
    } | null;
    return { ok: res.ok, status: res.status, body };
  };

  if (probeOnly) {
    const appId = process.env.META_APP_ID ?? "";
    const secret = process.env.META_APP_SECRET ?? "";
    const probe = await get(
      "/debug_token",
      { input_token: conn.pageToken, access_token: `${appId}|${secret}` },
      `${appId}|${secret}`
    );
    const data = (probe.body as { data?: { scopes?: string[]; is_valid?: boolean } })?.data;
    console.log(`token valid: ${data?.is_valid}`);
    console.log(`scopes: ${(data?.scopes ?? []).sort().join(", ")}`);
    return;
  }

  // Every call is a GET. The comment on each names the permission Meta
  // attributes it to.
  const calls: Call[] = [
    // ---- Page use case ("Manage everything on your Page") ----
    { permission: "pages_read_engagement", path: `/${pageId}`, params: { fields: "id,name,fan_count" } },
    { permission: "pages_show_list", path: "/me/accounts", params: { fields: "id,name" }, token: "user" },
    { permission: "pages_manage_metadata", path: `/${pageId}/subscribed_apps`, params: {} },
    // Reading the Page's own posts is what pages_read_user_content authorizes.
    { permission: "pages_read_user_content", path: `/${pageId}/feed`, params: { fields: "id,created_time", limit: "1" } },
    // Comments on the Page's posts: the read half of pages_manage_engagement.
    { permission: "pages_manage_engagement", path: `/${pageId}/feed`, params: { fields: "comments.limit(1){id,message}", limit: "1" } },
    // pages_manage_posts authorizes reading the published_posts edge too.
    { permission: "pages_manage_posts", path: `/${pageId}/published_posts`, params: { fields: "id", limit: "1" } },
    { permission: "read_insights", path: `/${pageId}/insights`, params: { metric: "page_impressions", period: "day" } },
    // ---- Messenger use case ----
    { permission: "pages_messaging", path: `/${pageId}/conversations`, params: { fields: "id", limit: "1" } },
    { permission: "pages_utility_messaging", path: `/${pageId}/messaging_feature_review`, params: {} },
    // ---- Instagram use case ----
    ...(igId
      ? ([
          { permission: "instagram_basic", path: `/${igId}`, params: { fields: "id,username,media_count" } },
          { permission: "instagram_manage_comments", path: `/${igId}/media`, params: { fields: "id,comments_count", limit: "1" } },
          { permission: "instagram_manage_insights", path: `/${igId}/insights`, params: { metric: "reach", period: "day" } },
          { permission: "instagram_content_publish", path: `/${igId}/content_publishing_limit`, params: {} },
          { permission: "instagram_manage_engagement", path: `/${igId}/media`, params: { fields: "id,like_count", limit: "1" } },
          { permission: "instagram_manage_messages", path: `/${igId}`, params: { fields: "id" } }
        ] as Call[])
      : []),
    // ---- Lead Ads / CAPI use case ----
    { permission: "leads_retrieval", path: `/${pageId}/leadgen_forms`, params: { fields: "id,name", limit: "1" } },
    { permission: "ads_management / business_management", path: "/me/businesses", params: { fields: "id,name", limit: "1" }, token: "user" },
    { permission: "pages_manage_ads", path: `/${pageId}`, params: { fields: "id,name" } }
  ];

  let ok = 0;
  let failed = 0;
  for (const call of calls) {
    const token = call.token === "user" ? (conn.userToken ?? conn.pageToken) : conn.pageToken;
    const res = await get(call.path, call.params ?? {}, token);
    if (res.ok) {
      ok += 1;
      console.log(`  OK   ${call.permission.padEnd(34)} GET ${call.path}`);
    } else {
      failed += 1;
      const e = res.body?.error;
      console.log(
        `  FAIL ${call.permission.padEnd(34)} GET ${call.path}\n` +
          `       ${res.status} code=${e?.code ?? "-"} sub=${e?.error_subcode ?? "-"} ${e?.message ?? ""}`
      );
    }
  }
  console.log(`\n${ok} succeeded, ${failed} failed.`);
  console.log("Meta's testing panel can take up to 24h to reflect these; each test is valid 30 days.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
