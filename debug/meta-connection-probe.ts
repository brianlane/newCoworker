/**
 * Diagnose a business's direct Meta Lead Ads connection: decrypt its stored
 * token and ask the Graph API what that token actually carries, chiefly the
 * granted scopes and granular page targets from /debug_token. Never prints
 * token material.
 *
 *   npx tsx debug/meta-connection-probe.ts [businessId]
 *
 * WHICH TOKEN: a connection keeps its user token only until it activates, at
 * which point user_token_encrypted is cleared and the permanent PAGE token is
 * all that remains. So on any live connection this probes the page token, and
 * /me resolves to the Page rather than to a person. /me/permissions and
 * /me/accounts exist only on a USER node, so they are skipped with a note
 * instead of printing a Graph "nonexisting field" error that reads like a bug
 * but is just the token type.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

/**
 * "Meta Review Sandbox (internal)". Deliberately NOT the New Coworker HQ
 * tenant (8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d), which has no
 * meta_connections row at all: the sandbox tenant is the only holder of one,
 * and the Page behind it is the real "New Coworker" Page (1202310049632520)
 * with the real @newcoworker Instagram account.
 *
 * This used to default to the HQ id, so a bare run printed "no
 * meta_connections row" and probed nothing unless you already knew to pass
 * the sandbox uuid.
 */
const SANDBOX_BUSINESS_ID = "e2b7a1c4-0000-4000-8000-000000000002";
const businessId = process.argv[2] ?? SANDBOX_BUSINESS_ID;

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
  // Everything below /me is user-token-only; see the file header.
  const onUserToken = Boolean(conn.userToken);

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

  if (onUserToken) {
    console.log("\n== /me/permissions ==");
    console.log(JSON.stringify((await get("/me/permissions")).body, null, 1));

    console.log("\n== /me/accounts ==");
    console.log(
      JSON.stringify((await get("/me/accounts", { fields: "id,name,tasks" })).body, null, 1)
    );
  } else {
    console.log(
      "\n== /me/permissions, /me/accounts ==\n" +
        " skipped: this connection is active, so only its PAGE token is stored" +
        " and both edges are USER-only.\n" +
        " The scopes below come from /debug_token and cover the same ground."
    );
  }

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
