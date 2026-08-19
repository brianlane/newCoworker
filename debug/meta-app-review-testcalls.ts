/**
 * Exercise the Graph API calls Meta's "Testing your use cases" panel counts,
 * so no permission row in App Review sits at "0 of 1 API call(s) required".
 *
 *   npx tsx debug/meta-app-review-testcalls.ts            # read-only calls
 *   npx tsx debug/meta-app-review-testcalls.ts --probe    # only report which
 *                                                        # permissions each
 *                                                        # token actually holds
 *
 * READ-ONLY BY DESIGN. Every call here is a GET. Meta counts a successful
 * call against the permission that AUTHORIZED it, not the one we intended,
 * so this script only fires a call when the token actually carries the
 * permission the row names; otherwise the row is reported as skipped. A
 * permission whose only real test is a WRITE is reported as "needs a write"
 * and skipped rather than performed: this runs against the live New Coworker
 * Page and Instagram account, and a test post is a real post.
 *
 * Tokens, and why neither needs manual refreshing:
 *  - Page calls use the stored PAGE token (permanent, no refresh flow).
 *  - User calls (/me/accounts and friends) use META_USER_LONG_TOKEN from
 *    .env, an exchanged long-lived user token with no expiry. The old
 *    META_USER_TEST_TOKEN (short-lived Explorer token, lapsed weekly) is
 *    dead; nothing reads it anymore. If META_USER_LONG_TOKEN is missing the
 *    user rows are SKIPPED LOUDLY, never silently downgraded to the page
 *    token: /me on a page token resolves to the Page, which has no
 *    `accounts` or `businesses` edge, so the fallback used to burn those
 *    rows with "(#100) nonexisting field" errors while looking like a run.
 *
 * Whose token does not matter to Meta: the testing panel attributes a call
 * to the APP that made it, via the token, not to any tenant id of ours.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

/**
 * "Meta Review Sandbox (internal)", NOT the New Coworker HQ tenant
 * (8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d), which despite the name has NO
 * meta_connections row at all. The sandbox tenant is the only holder of a
 * Meta connection, and the Page behind it is the real "New Coworker" Page
 * (1202310049632520) with the real @newcoworker IG account, so these calls
 * hit live assets and count toward App Review.
 *
 * Pointing this at the HQ id would find nothing and silently make zero calls.
 */
const SANDBOX_BUSINESS_ID = "e2b7a1c4-0000-4000-8000-000000000002";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const businessId = process.argv.find((a) => UUID_RE.test(a)) ?? SANDBOX_BUSINESS_ID;
const probeOnly = process.argv.includes("--probe");

type Call = {
  /** The permission row this call is meant to satisfy, as Meta labels it. */
  permission: string;
  path: string;
  params?: Record<string, string>;
  /** Which token to use: the page token (default) or the long user token. */
  token?: "page" | "user";
  /** The only real test is a mutation; never performed by this script. */
  needsWrite?: string;
};

async function main() {
  const { getMetaConnection } = await import("../src/lib/db/meta-connections.ts");
  const { META_GRAPH_BASE_URL } = await import("../src/lib/meta/client.ts");

  const conn = await getMetaConnection(businessId);
  if (!conn?.pageToken) {
    console.log(`no usable meta_connections row for business ${businessId}`);
    return;
  }
  const pageToken = conn.pageToken;
  const pageId = conn.page_id;
  const igId = conn.instagram_account_id;
  if (!pageId) {
    console.log("connection has no page_id");
    return;
  }
  const userToken = process.env.META_USER_LONG_TOKEN ?? null;
  if (!userToken) {
    console.log(
      "WARN META_USER_LONG_TOKEN is not in .env: the user-token rows " +
        "(public_profile, pages_show_list, business_management, ads_read, " +
        "ads_management) will be skipped, not downgraded to the page token."
    );
  }
  console.log(`page=${pageId} (${conn.page_name}) ig=${igId ?? "-"} (${conn.instagram_username ?? "-"})\n`);

  const get = async (path: string, params: Record<string, string>, token: string) => {
    const url = new URL(`${META_GRAPH_BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("access_token", token);
    const res = await fetch(url.toString());
    const body = (await res.json().catch(() => null)) as {
      data?: Array<Record<string, unknown>>;
      error?: { message?: string; code?: number; error_subcode?: number };
    } | null;
    return { ok: res.ok && !body?.error, status: res.status, body };
  };

  // What each token is actually allowed to do, from Meta's own debug_token.
  // A call made with a token that lacks the row's permission is credited to
  // whichever held permission authorized it, so it can never move that row.
  const appId = process.env.META_APP_ID ?? "";
  const secret = process.env.META_APP_SECRET ?? "";
  const scopesOf = async (token: string): Promise<Set<string>> => {
    const probe = await get(
      "/debug_token",
      { input_token: token },
      `${appId}|${secret}`
    );
    const data = (probe.body as { data?: { scopes?: string[]; is_valid?: boolean } } | null)?.data;
    if (data?.is_valid !== true) return new Set();
    return new Set(data.scopes ?? []);
  };
  const pageScopes = await scopesOf(pageToken);
  const userScopes = userToken ? await scopesOf(userToken) : new Set<string>();

  if (probeOnly) {
    console.log(`page token scopes (${pageScopes.size}): ${[...pageScopes].sort().join(", ")}`);
    console.log(
      userToken
        ? `user token scopes (${userScopes.size}): ${[...userScopes].sort().join(", ")}`
        : "user token: absent (META_USER_LONG_TOKEN not set)"
    );
    return;
  }

  // Discover the objects some rows need. These discovery reads are themselves
  // creditable calls (instagram_basic, pages_manage_ads, ads_read).
  const firstId = (r: Awaited<ReturnType<typeof get>>): string | null => {
    const row = r.body?.data?.[0];
    return typeof row?.id === "string" ? row.id : null;
  };
  const mediaId = igId
    ? firstId(await get(`/${igId}/media`, { fields: "id", limit: "1" }, pageToken))
    : null;
  const formId = firstId(
    await get(`/${pageId}/leadgen_forms`, { fields: "id", limit: "1" }, pageToken)
  );
  const actId = userToken
    ? firstId(await get("/me/adaccounts", { fields: "id", limit: "1" }, userToken))
    : null;

  // Every call is a GET. The `permission` on each row is the one Meta's
  // panel labels it with, and the call only runs when the token holds it.
  const calls: Call[] = [
    // ---- Page use case ("Manage everything on your Page") ----
    { permission: "pages_read_engagement", path: `/${pageId}`, params: { fields: "id,name,fan_count" } },
    { permission: "pages_show_list", path: "/me/accounts", params: { fields: "id,name" }, token: "user" },
    { permission: "pages_manage_metadata", path: `/${pageId}/subscribed_apps`, params: {} },
    // Ratings are the read pages_read_user_content actually gates; /feed only
    // needed Page Public Content Access and failed for the wrong reason.
    { permission: "pages_read_user_content", path: `/${pageId}/ratings`, params: { fields: "created_time", limit: "1" } },
    {
      permission: "pages_manage_engagement",
      path: "",
      needsWrite: "commenting as the Page is the gated action; reads ride pages_read_user_content"
    },
    {
      permission: "pages_manage_posts",
      path: "",
      needsWrite: "publishing or deleting a Page post is the gated action; /published_posts reads ride pages_read_engagement"
    },
    // page_impressions was retired in v25 and made this row fail every run;
    // page_views_total is a current metric.
    { permission: "read_insights", path: `/${pageId}/insights`, params: { metric: "page_views_total", period: "day" } },
    // ---- Messenger use case ----
    { permission: "pages_messaging", path: `/${pageId}/conversations`, params: { fields: "id", limit: "1" } },
    { permission: "pages_utility_messaging", path: `/${pageId}/messaging_feature_review`, params: {} },
    // ---- Instagram use case ----
    ...(igId
      ? ([
          { permission: "instagram_basic", path: `/${igId}`, params: { fields: "id,username,media_count" } },
          // Reading a media object's comments is the instagram_manage_comments
          // read; listing /{ig}/media is a plain instagram_basic call and was
          // being credited there, not here.
          ...(mediaId
            ? [{ permission: "instagram_manage_comments", path: `/${mediaId}/comments`, params: { fields: "id", limit: "1" } }]
            : []),
          { permission: "instagram_manage_insights", path: `/${igId}/insights`, params: { metric: "reach", period: "day", metric_type: "total_value" } },
          { permission: "instagram_content_publish", path: `/${igId}/content_publishing_limit`, params: {} },
          {
            permission: "instagram_manage_engagement",
            path: "",
            needsWrite: "publishing or deleting a Like is the gated action; like_count reads ride instagram_basic"
          },
          // IG DM threads live on the PAGE conversations edge with
          // platform=instagram; /{igId}?fields=id is a plain instagram_basic
          // read and was being credited there, not here.
          { permission: "instagram_manage_messages", path: `/${pageId}/conversations`, params: { platform: "instagram", fields: "id", limit: "1" } }
        ] as Call[])
      : []),
    // ---- Lead Ads / CAPI use case ----
    ...(formId
      ? [{ permission: "leads_retrieval", path: `/${formId}/leads`, params: { fields: "id", limit: "1" } }]
      : [{ permission: "leads_retrieval", path: `/${pageId}/leadgen_forms`, params: { fields: "id,name", limit: "1" } }]),
    { permission: "pages_manage_ads", path: `/${pageId}/leadgen_forms`, params: { fields: "id,name", limit: "1" } },
    { permission: "public_profile", path: "/me", params: { fields: "id,name" }, token: "user" },
    { permission: "business_management", path: "/me/businesses", params: { fields: "id,name", limit: "1" }, token: "user" },
    { permission: "ads_read", path: "/me/adaccounts", params: { fields: "id,name", limit: "1" }, token: "user" },
    ...(actId
      ? [{ permission: "ads_management", path: `/${actId}/campaigns`, params: { fields: "id,name", limit: "1" }, token: "user" as const }]
      : [])
  ];

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (const call of calls) {
    const label = call.permission.padEnd(34);
    if (call.needsWrite) {
      skipped += 1;
      console.log(`  SKIP ${label} needs a write: ${call.needsWrite}`);
      continue;
    }
    const wantsUser = call.token === "user";
    const token = wantsUser ? userToken : pageToken;
    const scopes = wantsUser ? userScopes : pageScopes;
    if (!token) {
      skipped += 1;
      console.log(`  SKIP ${label} no user token (set META_USER_LONG_TOKEN)`);
      continue;
    }
    if (!scopes.has(call.permission)) {
      skipped += 1;
      console.log(
        `  SKIP ${label} ${wantsUser ? "user" : "page"} token does not hold this scope; ` +
          "a call would be credited to another permission (re-grant via debug/meta-sandbox-regrant-url.ts)"
      );
      continue;
    }
    const res = await get(call.path, call.params ?? {}, token);
    if (res.ok) {
      ok += 1;
      console.log(`  OK   ${label} GET ${call.path}`);
    } else {
      failed += 1;
      const e = res.body?.error;
      console.log(
        `  FAIL ${label} GET ${call.path}\n` +
          `       ${res.status} code=${e?.code ?? "-"} sub=${e?.error_subcode ?? "-"} ${e?.message ?? ""}`
      );
    }
  }
  console.log(`\n${ok} succeeded, ${failed} failed, ${skipped} skipped.`);
  console.log("Meta's testing panel can take up to 24h to reflect these; each test is valid 30 days.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
