---
name: meta-app-review
description: Meta app review state, permission scope audit, and Testing-page sweep rules
metadata:
  type: project
---

## meta-app-review-state

Meta app (New Coworker, app id 1554839372962421): App Review DECIDED, seen
Aug 11 2026 (submitted Jul 20, submission_id 1555259042920454). APPROVED with
Advanced Access: leads_retrieval, pages_show_list, pages_manage_ads,
pages_read_engagement, pages_manage_metadata, pages_messaging, public_profile,
instagram_basic, instagram_manage_messages, whatsapp_business_messaging,
whatsapp_business_management. NOT APPROVED: instagram_content_publish (social
publishing to IG stays app-role-only). Rejection reason: "Screencast Not
Aligned with Use Case Details" (Policy 1.6): use case allowed, but the
screencast failed to show the end-to-end experience. Resubmit via "Request
again" with a recording showing: full Meta login flow, the grant screen with
the permission, composing AND publishing a post from the dashboard to the
sandbox IG (@newcoworker) with the live result, English UI + captions per the
Screen Recording Guide, and a note in the submission that background jobs do
the server-side publish. google-oauth-assets/recording-runbook.md is the
existing screencast pattern to mirror. ads_read /
ads_management / business_management were never in this submission; they ride
the Marketing API access tier (dev -> standard via the 500-call bar, fed
Aug 10). The stale pre-approval copy (README gate, MetaLeadsGuide tester note,
MetaIntegrationCard, PRD review chain) was swept in PR #1309, merged and
deployed Aug 11. Direct Meta connect, WhatsApp Embedded Signup, and
Messenger/IG DM are open to arbitrary customers. Still open as of Aug 11:
contest or resubmit instagram_content_publish (Brian believes the July
screencast already shows the full E2E; the play is "Ask a question" with
timestamps first, re-record second), activate CAPI dataset discovery for
tenants, consider promoting direct connect over the bridge in the guide
flow, and verify the Marketing API tier counter cleared 500 (Aug 10 grind;
check via devtools_api_usage MCP or the Testing page).

Use-case Testing rows (Review > Testing) decay: each test call counts for only
30 days, with up to 24h reporting lag. Keep-warm mechanics, proven Aug 10:

- The Meta Review Sandbox tenant (e2b7a1c4-0000-4000-8000-000000000002) holds a
  never-expiring PAGE token (page 1202310049632520, IG 17841425768135944,
  test form "NCW smoke test form" 1046869914952916) and a WABA token
  (waba 946708858446787, phone 1267081729812869, 60-day expiry from Jul 20,
  so ~Sep 18). Read-only GETs exercise 10 perms: leadgen_forms + /leads
  (leads_retrieval AND pages_manage_ads), page fan_count
  (pages_read_engagement), subscribed_apps (pages_manage_metadata),
  conversations (pages_messaging), conversations?platform=instagram
  (instagram_manage_messages), IG username (instagram_basic),
  content_publishing_limit (instagram_content_publish), WABA phone_numbers/name
  (whatsapp_business_management), phone quality + business_profile
  (whatsapp_business_messaging). /{page}/ads_posts 403s on a page token; skip.
- pages_show_list, public_profile, business_management, ads_read,
  ads_management need a USER token (Graph API Explorer): /me, /me/accounts,
  /me/businesses, /me/adaccounts, /act_992080513587562 reads. No user token is
  stored (meta_connections rows have user_token_encrypted NULL); the working
  pattern is Brian generates one in Explorer and drops it in .env as
  META_USER_TEST_TOKEN (short-lived, ~2h).
- Full refresh ran Aug 10 2026 (both halves, ~370 successful calls, zero Graph
  failures), so every submitted permission's 30-day test window runs to ~Sep 9.
  Runner scripts (gitignored): debug/.tmp-meta-keepwarm.ts (page+WABA tokens)
  and debug/.tmp-meta-user-keepwarm.ts (user token). Dashboard counters lag up
  to 24h.
- The Marketing API Access Tier "500 calls / 85% success" counter counts ONLY
  ads (act_*) endpoints; leadgen/pages/IG/WhatsApp calls never move it (July's
  92 such calls left it at 0). Cleared Aug 10: debug/.tmp-meta-tier-grinder.ts
  made 520/520 act_992080513587562 reads at 100% success in 100m, ~600 ads
  calls total that day. App is development_access tier; the binding budget is
  300 ads-management calls per ROLLING hour per ad account (continuous decay,
  not a scheduled reset; CPU/time budgets are irrelevant at our volume). The
  grinder self-paces off x-app-usage / x-business-use-case-usage headers,
  whose percentages match the dashboard's rate-limit page exactly.
- META_USER_LONG_TOKEN in .env: exchanged long-lived user token, NO expiry
  (data access to Nov 8 2026), all 15 scopes; reruns need no new Explorer
  token. Meta Developer Tools MCP (mcp.facebook.com/devtools) is registered at
  user scope and authenticated; next sessions get devtools_app_review /
  devtools_api_usage / devtools_compliance for dashboard-free status checks.
- NEVER run `debug/meta-reviewer-setup.ts --apply` while a review is pending:
  every apply ROTATES meta.reviewer@newcoworker.com's password and would break
  the credentials Meta already holds. Reviewer last_sign_in_at 2026-07-20.
- Sandbox WABA stock templates sit FAILED/PENDING (pre-PR-#1137 es_US bug);
  out-of-window template sends on the sandbox will skip until re-registered.

CAPI dataset auto-discovery is built on an endpoint that does not exist in
Meta's public API. `POST /{page_id}/dataset` (src/lib/meta/client.ts
getOrCreatePageDataset) 403s with `(#200) App does not have page_events
permission on the Page` for BOTH the page token and a user token carrying
ads_management + business_management (probed Aug 12 2026), so it is an
app-level gap, not a token one. But do NOT chase that permission:
`page_events` singular is not a real reviewable permission (the real one is
`pages_events`, and the error string leaks a legacy alias), the endpoint is
undocumented (developers.facebook.com/docs/graph-api/reference/page/dataset/
is a 404), and no CAPI review path requests it.

CORRECTION Aug 13 2026: `POST /{page_id}/dataset` IS documented and
`page_events` IS obtainable : but both belong to a DIFFERENT Meta product.
The endpoint lives in "Conversions API for Business Messaging"
(developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging),
which is explicitly for conversions that happen INSIDE a messaging thread,
"not conversions that occur on other channels". That page says to apply for
`page_events` in the App Dashboard's legacy "Permissions and Features"
section, and that an app already holding `pages_messaging` advanced access
(we do, since Aug 11) "should be automatically approved for page_events
permission after you apply". Caveat: that legacy panel exists on App-Type
apps; a use-case app may not show it, which is why it looked missing.
So the old code was calling the right endpoint for the WRONG product: we
wanted CRM lead stages, not messaging conversions. Removing it stays correct.
`page_events` is worth pursuing only if we build CAPI for Business Messaging
(reporting Messenger/IG DM/WhatsApp conversions so ads optimize for
conversations that convert) : a real future feature given we run all three.

RESOLVED Aug 13 2026: `pages_events` is not needed for Conversion Leads at
all. Meta's CAPI Get Started states the upload "does not need to go through
App Review. You do not need to request any permissions" : a token with access
to the dataset suffices, and `POST /{dataset_id}/events` takes no Page
permission. Page association is not required either: the Instant Form
`lead_id` is the join key, and the Page node has no documented `dataset`
edge. Proven live with the scopes we already hold:
`GET /{business_id}/owned_pixels?fields=id,name,is_crm` and `client_pixels`
both return 200 (documented discovery, per the Facebook-Login-for-Business
CAPI template), `GET /{dataset_id}` reads full fields, and the PAGE token our
uploader passes carries ads_management + business_management and reads
dataset objects fine. What has NO API: creating or converting a dataset to
CRM : `is_crm` is read-only and the advertiser must use Events Manager >
Connect Data Source > CRM. Partner access to a client dataset is
`POST /{pixel_id}/agencies?business=<ours>&permitted_tasks=["UPLOAD","ANALYZE"]`
(MBE channel CONVERSIONS_API is "preferred" but needs the allowlisted
manage_business_extension). Payload nesting matters: `lead_id` under
`user_data`, `event_source:"crm"` + `lead_event_source` under `custom_data`,
`action_source:"system_generated"`.

The DOCUMENTED Conversion Leads flow for a tech provider has no Page-level
permission at all: the advertiser creates the CRM dataset in Events Manager
(Connect Data Sources > CRM), shares it, and the platform posts to
`/{pixel_id}/events` : dataset id is a per-tenant ONBOARDING INPUT, not
something we discover. Meta's "Conversions API for CRM for Platforms" page
requires Advanced Access for ads_management, ads_read, pages_read_engagement,
pages_show_list, business_management, plus the Marketing API Access Tier.
Fix direction: delete getOrCreatePageDataset + the backfill one-shot, and
take dataset_id per tenant instead. Code degrades safely meanwhile
(discovery returns null, nothing written, events keep deferring).

Production does not depend on the review: real tenants get leads via
Zapier/Make bridges; the only meta_connections rows are HQ (pending, no
tokens) and the sandbox. See [[email-routing-catchall-is-the-product]] for the
adjacent mail plumbing rule.

## meta-permission-scope-audit

Audit done Aug 12 2026 against every Graph call in the repo (all funnel
through src/lib/meta/client.ts graphRequest + capi.ts).

Authoritative check Aug 13 via the Meta MCP (devtools_app_review action
`privileges`, app 1554839372962421): exactly 12 privileges are live at
advanced access (the Aug 11 eleven, plus `openid` which we never use).
Everything else, including the entire staged cart, reads access_level
"none". `page_events`/`pages_events` does NOT appear anywhere in the app's
50+ privilege universe, which is why it cannot be found in the dashboard:
there is nothing to request for this app. Use `privileges` as the fast
source of truth instead of screenshots. Marketing API Access Tier threshold
is 500 Marketing API calls in the PAST 15 DAYS (rolling), so the Aug 10-11
grind of ~600 stays valid only until roughly Aug 25.

APPROVED Aug 11 and genuinely used: leads_retrieval + pages_manage_ads
(GET /{leadgen_id}), pages_show_list (/me/accounts page picker),
pages_manage_metadata (POST/DELETE /{page}/subscribed_apps),
pages_messaging (POST /{page}/messages : carries BOTH Messenger and IG DM),
pages_read_engagement (page node reads), instagram_basic (linked IG resolve
+ permalink), instagram_manage_messages (IG DM), public_profile (/me?name),
whatsapp_business_messaging + whatsapp_business_management (Cloud API;
granted via Embedded Signup config_id, deliberately NOT in META_LOGIN_SCOPES).

STILL NEEDED, not granted:
- instagram_content_publish (REJECTED): the only blocker for IG publishing
  (src/lib/social/publish.ts; 4 social_posts rows, 1 published via app-role).
- instagram_manage_comments (NEVER REQUESTED : real gap): we subscribe the
  `comments` field on the instagram object in the App Dashboard and turn
  each into an `instagram_comment` AiFlow trigger
  (src/lib/meta/webhook.ts processMetaCommentEvent). Either request it or
  delete the feature.
- ads_management / ads_read / business_management / Marketing API Access
  Tier: required by Meta's "Conversions API for CRM for Platforms" doc, and
  only for the Conversion Leads loop. Production makes ZERO Marketing API
  ads calls otherwise. Tier read 602 calls but still "Limited access" on
  Aug 12: the tier must be SUBMITTED for review to actually upgrade
  (threshold is 500 calls in 15 days).

Aug 15 2026 submission prep: cart trimmed to the 6 keepers, and all six now
show `use_case` and `data_use_checkup` COMPLETE. Only `api_precheck` (lags,
Meta says testing data takes up to 24h) and `screencast` remain. Reconnecting
the sandbox tenant through our own Connect Facebook flow granted the new
scope: its PAGE token went 15 -> 16 scopes and now carries
`instagram_manage_comments`, which is what made a real precheck possible (12
successful `/{media}/comments` reads). Before that reconnect, comment reads
still returned 200 because we own the media, so they were being credited to
`instagram_basic` : a token WITHOUT the permission is not a valid precheck.
BLOCKER: `can_submit` is still false, "Cannot submit to App Review while a
previous submission is in review", while the only submission on record
(Aug 11) is closed. Probe or escalate that before investing in screencasts.

DELETE from the staged App Review cart (no code path anywhere; a bloated ask
invites scope-discrepancy rejection): Instagram Public Content Access,
Business Asset User Profile Access, pages_read_user_content,
pages_manage_engagement, pages_manage_posts (we publish to IG only, never a
FB Page feed), read_insights, catalog_management, email (we read only
/me?fields=name), pages_user_gender/timezone/locale, paid_marketing_messages,
marketing_messages_messenger, pages_utility_messaging (24h window + SMS
fallback instead), whatsapp_business_manage_events, every
facebook_branded_content_* / facebook_creator_marketplace_discovery, every
instagram_branded_content_*, instagram_manage_insights /
instagram_manage_engagement / instagram_manage_contents /
instagram_shopping_tag_products / instagram_manage_upcoming_events /
instagram_creator_marketplace_discovery, and the whole instagram_business_*
family (that is the Instagram-Login flavor of the API; we use Instagram via
Facebook Login, so instagram_* is the correct family).

See [[meta-app-review-state]] for review history and the dataset trap.

## meta-testing-page-full-sweep

Ran every permission row on the Meta Testing page (app 1554839372962421)
on 2026-08-18. Harness: `debug/.tmp-meta-full-testing.ts` (gitignored,
49 rows, read-only) + `.tmp-meta-testing-v2.ts` (body dumps + retries).
Result: 16 CREDITED, 15 succeeded-but-UNCREDITED, 18 DENIED.

**A test call only counts for permission X if the TOKEN CARRIES X.** Both
our page token and META_USER_LONG_TOKEN carry the SAME 16 scopes, so those
16 are the entire creditable set. Everything else returns 200 or 403 but is
attributed elsewhere. This is the same trap as the instagram_manage_comments
reconnect (see [[meta-permission-scope-audit]]).

**`pages_user_locale` / `pages_user_timezone` / `pages_user_gender` are NOT
OAuth scopes.** They are Messenger Platform FEATURE reviews, requested via
`GET /{page}/messaging_feature_review` (which returns `{"data":[]}` for us,
meaning none submitted). Proven with an OAuth-dialog probe: a real scope
302s to login.php, a non-scope 500s, exactly like a nonsense control string.
No Graph call will ever credit those three rows; they need a Messenger
feature submission, not a permission request.

**Probe technique worth reusing** (read-only, no grant performed): GET
`https://www.facebook.com/v25.0/dialog/oauth?client_id=..&redirect_uri=..
&response_type=code&scope=<one scope>` with redirect:manual.
302 -> login.php = grantable scope. 500 = not a scope. ALWAYS include a
known-good control AND a nonsense control: the login redirect URL contains
the literal substring `error_code`, so a naive regex marks every scope as
rejected. 29 of the 33 probed names are grantable, including every
review-REJECTED one, so app-role Standard Access still lets an admin mint a
token with them.

**200 does not mean the data arrived.** `GET /me?fields=id,name,email`
returns 200 with `{id,name}` and NO email key: the gated field is silently
dropped, never an error. Same for `timezone` on a PSID read. But `locale`,
`gender`, `first_name`, `last_name`, `profile_pic` DO come back on a PSID
with only pages_messaging. Assert on the FIELD, not the status code.

Other findings: `page_impressions`/`page_impressions_unique`/`page_fans` are
retired in v25 (#100 "must be a valid insights metric"); working metrics are
`page_daily_follows_unique`, `page_views_total`, `page_post_engagements`.
`/{page}/feed` needs Page Public Content Access, but `/{page}/posts` and
`/published_posts` work on pages_read_engagement. IG mentions edge is
`/{ig}/tags`. `/{page}/message_templates` is gated on
pages_utility_messaging, not on a marketing-messages permission.
Hard (#10) gates with no read-only workaround: instagram_manage_insights,
instagram_shopping_tag_products.

Remaining step to finish the sweep: a Graph API Explorer token carrying the
28 extra grantable scopes, then rerun the harness. Brian must mint it (the
OAuth grant is his to approve).

TESTING SWEEP + RE-GRANT (Aug 18-20 2026, PR #1506): the tracked harness
debug/meta-app-review-testcalls.ts is FIXED (user rows use
META_USER_LONG_TOKEN and skip loudly, read_insights uses page_views_total,
rows fire only when the token holds the named scope; META_USER_TEST_TOKEN is
dead legacy, never tell Brian to paste a token). A test call credits the
permission that AUTHORIZED it, so only token-held scopes count; the
companion debug/meta-sandbox-regrant-url.ts prints a wider-scope Facebook
Login URL (state minted via the stateless HMAC helper, 15-min TTL) for
re-granting the sandbox. Brian ran it Aug 19: BOTH the sandbox page token
and META_USER_LONG_TOKEN went 16 -> 36 scopes (grants are cumulative per
user+app pair, no re-issue needed). Harness now 18 OK / 0 fail / 3
needs-write skips; dashboard Aug 20 shows Marketing API, WhatsApp,
Messenger, and Page use cases "Testing complete". Instagram stays "Testing
in progress" ONLY because of the instagram_business_* family (IG-Login API
flavor, structurally unreachable from our Facebook-Login integration) which
is NOT in the pending submission and blocks nothing; leave it, and do not
touch use-case config while the review is pending. Creator marketplace:
scope granted but the API refuses ("brand is not onboarded"), fix would be
Business Suite onboarding + real ad spend; deliberately abandoned, do not
re-chase. pages_user_locale/timezone/gender are NOT scopes (Messenger
feature reviews via /{page}/messaging_feature_review); the OAuth dialog
500s on them vs 302-to-login for real scopes, and a naive probe regex
false-flags every scope because the login redirect contains the literal
substring "error_code". A 200 can silently DROP the gated field (email,
timezone): assert on the field, not the status. WATCH: Marketing API Access Tier api_precheck rides a rolling 15-day
500-call window. Re-ground Aug 24 2026 (520/520 ok, 100% success, 87m,
review still PENDING), so the window is safe to ~Sep 8 2026; if the
submission is STILL pending near then, run
debug/.tmp-meta-tier-grinder.ts again (self-paces, ~90m).

REVIEW DECIDED ~Aug 25 2026 (submission 1578655697247455, submitted Aug 17):
APPROVED at advanced access: Marketing API Access Tier,
instagram_manage_comments, instagram_content_publish (the July rejection is
cleared; IG publishing now open to arbitrary customers), business_management,
ads_management. REJECTED: ads_read only, same "Screencast Not Aligned"
Policy 1.6 reason; Meta's guidance point 5 says to state in the resubmission
that the app is server-to-server / uses stored tokens so the missing
frontend login flow is expected, which is exactly our ads_read usage
(Conversion Leads reads). ads_management supersedes ads_read for every Graph
read in practice, so nothing is functionally blocked; resubmitting ads_read
is optional polish and its Testing row stays warm to ~Sep 23 from the
Aug 24 calls. 17 privileges now live at advanced. The tier is GRANTED:
retire the grinder and the Sep 8 window watch permanently. Review freeze
lifted: reviewer-setup --apply and use-case config edits are safe again.
Post-decision sweep: README's "app-role-only until a resubmission" passage
was the stale copy to fix (PR opened same day).

ads_read PROVEN unnecessary Aug 28 2026 (debug/.tmp-ads-read-proof.ts,
gitignored): DELETE /me/permissions/ads_read succeeded and BOTH sandbox
tokens immediately read ads_read:false (scopes are evaluated live per
user+app grant, the page token follows the user grant), yet /{act}/insights,
/{act}/campaigns, and /me/adaccounts all still 200 via ads_management, and
owned_pixels discovery still 200 via business_management. The sandbox grant
NOW LACKS ads_read (35 scopes): its Testing row cannot be kept warm unless
Brian re-runs debug/meta-sandbox-regrant-url.ts, which only matters if
ads_read is ever resubmitted. Decision stance: never resubmit unless a
future feature needs read-only ads tokens. Note the sandbox business owned
NO pixel on Aug 28 (owned_pixels empty; the Aug 13 one is gone), so dataset
node/write probes need a pixel recreated in Events Manager first.

CONNECTION TOPOLOGY CHANGED Aug 28 2026: HQ (8f3a5c21) connected the New
Coworker Page via the dashboard and now holds the ACTIVE meta_connections
row (page 1202310049632520, IG @newcoworker, 35-scope token: the wide grant
minus revoked ads_read). The Meta Review Sandbox tenant (e2b7a1c4-...0002)
LOST its row when the Page claim moved: anything defaulting to the sandbox
id finds nothing. debug/meta-app-review-testcalls.ts re-defaulted to HQ in
PR #1705. HQ blog cross-posting to IG now runs on a customer-grade token,
no app role involved. ALSO: KIN Integrated Child Health (a912aff5) started
a Meta connect Aug 25 02:26 UTC and sits PENDING with no page picked, a
real customer stalled at the page-pick step on /dashboard/integrations/meta
since the day approval landed; Brian may want to nudge them.
