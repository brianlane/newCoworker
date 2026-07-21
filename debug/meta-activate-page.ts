/**
 * One-shot: finish a PENDING direct Meta connection for a business whose
 * Page does not appear on /me/accounts (business-portfolio-owned Pages).
 * Mirrors POST /api/integrations/meta exactly: fetch the page token via
 * the Graph page node, subscribe the Page to leadgen+messaging, resolve
 * the linked IG account, and activate the connection row.
 *
 *   npx tsx debug/meta-activate-page.ts <businessId> <pageId>
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const businessId = process.argv[2];
const pageId = process.argv[3];
if (!businessId || !pageId) {
  console.error("usage: npx tsx debug/meta-activate-page.ts <businessId> <pageId>");
  process.exit(1);
}

async function main() {
  const { getMetaConnection, activateMetaConnection } = await import(
    "../src/lib/db/meta-connections.ts"
  );
  const {
    META_GRAPH_BASE_URL,
    subscribePageToLeadgen,
    getLinkedInstagramAccount
  } = await import("../src/lib/meta/client.ts");

  const conn = await getMetaConnection(businessId);
  if (!conn?.userToken) {
    throw new Error("no pending connection with a user token — run the OAuth connect first");
  }
  if (conn.status !== "pending") {
    throw new Error(`connection status is ${conn.status}, expected pending`);
  }

  // Fetch the page's name + page token directly (granular grant covers it
  // even when /me/accounts is empty).
  const url = new URL(`${META_GRAPH_BASE_URL}/${pageId}`);
  url.searchParams.set("fields", "id,name,access_token");
  url.searchParams.set("access_token", conn.userToken);
  const res = await fetch(url);
  const page = (await res.json()) as {
    id?: string;
    name?: string;
    access_token?: string;
    error?: { message?: string };
  };
  if (!res.ok || !page.access_token) {
    throw new Error(`page fetch failed (${res.status}): ${page.error?.message ?? "no token"}`);
  }
  console.log(`page: ${page.id} "${page.name}" — token acquired`);

  await subscribePageToLeadgen(page.id!, page.access_token);
  console.log("leadgen+messaging subscription confirmed");

  const instagram = await getLinkedInstagramAccount(page.access_token, page.id!);
  console.log(`linked instagram: ${instagram ? `${instagram.id} (@${instagram.username})` : "none"}`);

  const row = await activateMetaConnection({
    businessId,
    pageId: page.id!,
    pageName: page.name ?? null,
    pageToken: page.access_token,
    instagramAccountId: instagram?.id ?? null,
    instagramUsername: instagram?.username ?? null
  });
  console.log(
    `activated: status=${row.status} page=${row.page_id} "${row.page_name}" ig=${row.instagram_username ?? "-"}`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
