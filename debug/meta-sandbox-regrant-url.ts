/**
 * Print a Facebook Login URL that re-grants the Meta Review Sandbox
 * connection with MORE scopes than production asks for, so App Review
 * "Testing" rows beyond the production grant can register real test calls.
 *
 *   npx tsx debug/meta-sandbox-regrant-url.ts
 *
 * Why this exists: a stored token carries exactly the scopes granted at
 * connect time. Production META_LOGIN_SCOPES must stay minimal (every real
 * customer sees that grant screen, and unapproved scopes on it invite a
 * scope-discrepancy rejection at review), so widening the sandbox goes
 * through a one-off URL instead. App admins get Standard Access to these
 * permissions without App Review approval, which is exactly what the
 * Testing panel measures.
 *
 * How it works: the OAuth `state` is a stateless HMAC over the app secret
 * (src/lib/meta/client.ts createMetaOAuthState), so this script can mint a
 * valid one for the sandbox business id. The printed URL is the standard
 * dialog with a wider `scope` list; the production callback verifies the
 * state and stores the connection as pending, exactly like a normal connect.
 *
 * To use it:
 *   1. Be logged into the dashboard as an admin, in the same browser.
 *   2. Open the printed URL within 15 minutes (state TTL), approve.
 *   3. Finish the Page pick on /dashboard/integrations/meta.
 *   4. Verify: npx tsx debug/meta-app-review-testcalls.ts --probe
 *
 * Facebook grants are cumulative per user+app, so previously granted scopes
 * (including the WhatsApp pair, which ride Embedded Signup, not this dialog)
 * survive the re-grant; this proved out when the Aug 15 2026 reconnect took
 * the sandbox page token from 15 to 16 scopes without losing any.
 *
 * NEVER paste this URL to a customer and never widen META_LOGIN_SCOPES to
 * replicate it.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const SANDBOX_BUSINESS_ID = "e2b7a1c4-0000-4000-8000-000000000002";

/**
 * Scopes beyond META_LOGIN_SCOPES that the OAuth dialog accepts for this
 * app (verified 2026-08-18 by probing the dialog per scope: a real scope
 * 302s to login.php, a non-scope 500s). pages_user_locale / _timezone /
 * _gender are absent because they are NOT scopes: they are Messenger
 * feature reviews, requested per Page via /{page}/messaging_feature_review.
 */
const EXTRA_SCOPES = [
  "public_profile",
  "email",
  "ads_read",
  "read_insights",
  "catalog_management",
  "pages_read_user_content",
  "pages_manage_posts",
  "pages_manage_engagement",
  "pages_utility_messaging",
  "marketing_messages_messenger",
  "paid_marketing_messages",
  "instagram_manage_insights",
  "instagram_manage_engagement",
  "instagram_manage_contents",
  "instagram_manage_upcoming_events",
  "instagram_shopping_tag_products",
  "instagram_branded_content_brand",
  "instagram_branded_content_creator",
  "instagram_branded_content_ads_brand",
  "instagram_creator_marketplace_discovery",
  "facebook_branded_content_ads_brand",
  "facebook_creator_marketplace_discovery"
] as const;

/**
 * The instagram_business_* family belongs to the Instagram-Login flavor of
 * the API (we integrate Instagram via Facebook Login, the instagram_*
 * family). The dialog accepts them individually, but they are kept out of
 * the main URL so an incompatibility cannot sink the whole grant; use the
 * second printed URL if those rows are ever worth exercising.
 */
const IG_LOGIN_FAMILY_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
  "instagram_business_content_publish",
  "instagram_business_manage_insights"
] as const;

async function main() {
  const { buildMetaLoginUrl, createMetaOAuthState, metaCallbackUrl, META_LOGIN_SCOPES } =
    await import("../src/lib/meta/client.ts");

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.newcoworker.com";
  const makeUrl = (scopes: readonly string[]): string => {
    const url = new URL(
      buildMetaLoginUrl({
        redirectUri: metaCallbackUrl(origin),
        state: createMetaOAuthState(SANDBOX_BUSINESS_ID)
      })
    );
    // buildMetaLoginUrl pins scope to META_LOGIN_SCOPES; the dialog itself
    // does not bind scope into the state, so widening it here is valid.
    url.searchParams.set("scope", scopes.join(","));
    return url.toString();
  };

  const full = [...new Set([...META_LOGIN_SCOPES, ...EXTRA_SCOPES])];
  console.log(`sandbox business: ${SANDBOX_BUSINESS_ID}`);
  console.log(`scopes requested: ${full.length} (production asks ${META_LOGIN_SCOPES.length})`);
  console.log("\nOpen while logged into the dashboard as an admin; valid 15 minutes:\n");
  console.log(makeUrl(full));
  console.log("\nVariant including the Instagram-Login family (only if those rows matter):\n");
  console.log(makeUrl([...full, ...IG_LOGIN_FAMILY_SCOPES]));
  console.log("\nThen finish the Page pick on /dashboard/integrations/meta and verify with:");
  console.log("  npx tsx debug/meta-app-review-testcalls.ts --probe");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
