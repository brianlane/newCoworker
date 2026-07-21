/**
 * Diagnose a business's direct Meta Lead Ads connection: decrypt the stored
 * user token and ask the Graph API what it actually carries — granted
 * permissions (with granular page targets via /debug_token) and the Pages
 * visible on /me/accounts. Never prints token material.
 *
 *   npx tsx debug/meta-connection-probe.ts [businessId]
 *
 * Defaults to the New Coworker HQ internal tenant.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const businessId = process.argv[2] ?? HQ_BUSINESS_ID;

async function main() {
  const { getMetaConnection } = await import("../src/lib/db/meta-connections.ts");
  const { META_GRAPH_BASE_URL } = await import("../src/lib/meta/client.ts");

  const conn = await getMetaConnection(businessId);
  if (!conn) {
    console.log(`no meta_connections row for business ${businessId}`);
    return;
  }
  console.log(
    `connection: status=${conn.status} is_active=${conn.is_active} ` +
      `account=${conn.account_name} page=${conn.page_id ?? "-"} ` +
      `userToken=${conn.userToken ? "present" : "null"} ` +
      `pageToken=${conn.pageToken ? "present" : "null"}`
  );
  const token = conn.userToken ?? conn.pageToken;
  if (!token) {
    console.log("no token to probe");
    return;
  }

  const get = async (path: string, params: Record<string, string> = {}) => {
    const url = new URL(`${META_GRAPH_BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("access_token", token);
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };

  console.log("\n== /me ==");
  console.log(JSON.stringify((await get("/me", { fields: "id,name" })).body));

  console.log("\n== /me/permissions ==");
  console.log(JSON.stringify((await get("/me/permissions")).body, null, 1));

  console.log("\n== /me/accounts ==");
  console.log(
    JSON.stringify(
      (await get("/me/accounts", { fields: "id,name,tasks" })).body,
      null,
      1
    )
  );

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (appId && appSecret) {
    const url = new URL(`${META_GRAPH_BASE_URL}/debug_token`);
    url.searchParams.set("input_token", token);
    url.searchParams.set("access_token", `${appId}|${appSecret}`);
    const res = await fetch(url);
    const body = (await res.json().catch(() => ({}))) as {
      data?: Record<string, unknown>;
    };
    console.log("\n== /debug_token (granular scopes) ==");
    const d = body.data ?? {};
    // Strip anything token-like just in case; print the interesting fields.
    console.log(
      JSON.stringify(
        {
          type: d.type,
          is_valid: d.is_valid,
          scopes: d.scopes,
          granular_scopes: d.granular_scopes,
          expires_at: d.expires_at,
          data_access_expires_at: d.data_access_expires_at
        },
        null,
        1
      )
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
