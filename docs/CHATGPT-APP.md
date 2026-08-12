# ChatGPT app (OpenAI Apps SDK): setup and operations

New Coworker as an app inside ChatGPT. The single most useful thing to know:
**a ChatGPT app is a remote MCP server.** OpenAI retired `ai-plugin.json`, and
the Apps SDK is MCP underneath, so the Claude connector
(README "Claude connector (remote MCP)") is most of the product already. What
is genuinely new is the metadata OpenAI demands, two extra tools, a domain
proof, and the listing.

Companion to `docs/SLACK-INTEGRATION.md`, which is the model for how a
marketplace submission is run here.

---

## Architecture map

| Piece | Path |
| --- | --- |
| Route factory (auth, status stamp, 401 shaping) | `src/lib/mcp/server.ts` |
| Client registry (routes, metadata paths) | `src/lib/mcp/routes.ts` |
| Claude endpoint | `src/app/api/mcp/route.ts` |
| ChatGPT endpoint | `src/app/api/mcp/chatgpt/route.ts` (live since 2026-08-11) |
| Tool registry (31 tools) | `src/lib/mcp/registry.ts`, `src/lib/mcp/tools/*` |
| Tool metadata contract (titles, annotations, output schemas) | `src/lib/mcp/tooling.ts` |
| OAuth discovery metadata | `src/lib/mcp/oauth.ts` + `src/app/.well-known/oauth-protected-resource/**` |
| Domain-ownership proof | `src/app/.well-known/openai-apps-challenge/route.ts`, `src/lib/marketing/openai-apps.ts` |
| Per-connector status | `src/lib/mcp/connector-status.ts`, table `mcp_connector_status` |

---

## Env contract

| Variable | Purpose |
| --- | --- |
| `OPENAI_APPS_CHALLENGE_TOKEN` | Domain-ownership token from the submission portal. Served as **plain text** at `/.well-known/openai-apps-challenge`. Unset means the route 404s and the feature is simply off. |

Verification is per **host**, not per path: OpenAI ignores the path of the
submitted MCP URL, so one token covers `/api/mcp` and every `/api/mcp/*` route.
Paste the bare token. The accessor refuses whitespace, a pasted JSON blob, and
implausible lengths, and 404s rather than serving something the portal will
reject, because the portal reports only that verification failed.

---

## What OpenAI requires that Claude never asked for

Every one of these is a documented rejection cause, and the first is the most
cited:

1. **Per-tool annotations**: `readOnlyHint`, `destructiveHint`, `openWorldHint`.
2. **A human-readable `title`** per tool, alongside the snake_case name.
3. **An `outputSchema`** per tool, and `structuredContent` in every result.
   These two are inseparable: declaring a schema and returning text only makes
   the SDK fail **every** call with "has an output schema but no structured
   content was provided".
4. **`search` and `fetch` tools.** ChatGPT rejects a server lacking both unless
   the user has Developer Mode on, so passing in Developer Mode does **not**
   prove we pass the normal gate.
5. **Domain verification** at the well-known path above.
6. **A demo account** that works with no MFA, no email confirmation, and no
   private-network access.

### Annotate what a call sets in motion

The rule that is easy to get wrong, and wrong in the reassuring direction. A
tool answers for what the call **starts**, not for what its own function body
touches:

- `create_contact` looks like a row insert, but it fires `contact_created`,
  which enqueues AiFlows that can text or email the person. Open-world.
- `trigger_flow` and `run_flow` start owner-authored flows whose
  `update_contact` step can carry `removeTags`. Destructive.
- `set_flow_enabled` only changes eligibility for runs that a later,
  independent trigger causes. Stays local.

`tests/mcp-tool-metadata-guard.test.ts` pins the cases no static check can see.

---

## OAuth, and what Supabase actually does

Supabase Auth is the authorization server; we host only the consent page.
Probed against production with `debug/mcp-oauth-resource-probe.ts`:

| Capability | Answer |
| --- | --- |
| `authorization_endpoint` / `token_endpoint` | advertised |
| `registration_endpoint` (DCR) | advertised |
| S256 PKCE | advertised |
| `scopes_supported` | `openid profile email phone offline_access` |
| `userinfo_endpoint` | **advertised**, so ChatGPT Enterprise workspace domain verification is reachable |
| `resource_parameter_supported` (RFC 8707) | **absent** |
| `client_id_metadata_document_supported` (CIMD) | **absent**, so DCR stays our path |

**Settled by a live connection, not by the probe.** On 2026-08-11 ChatGPT
connected to `/api/mcp` end to end against production: metadata discovery,
dynamic client registration, the consent page, token exchange, and
authenticated tool calls. `list_businesses`, `get_business` and `list_flows`
all returned real data in a conversation.

So Supabase-as-authorization-server is viable and the RFC 8707 question is no
longer blocking. What remains open is only whether Supabase **binds** the
`resource` into the token's `aud`, which matters if we ever want to enforce
audience. We do not today. `debug/mcp-oauth-resource-probe.ts` still answers it
if needed; it requires a browser consent, and note that the code in the
redirect is the `code=` value, not the `code_challenge` from the authorize URL.

> **Security note, independent of ChatGPT.** If every token for this project
> carries `aud: "authenticated"`, then any Supabase access token for the
> project, including a dashboard session token, is a valid MCP bearer. That is
> the status quo, not something this work introduces, but it is worth writing
> down.

### Redirect URIs

ChatGPT redirects to `https://chatgpt.com/connector/oauth/{callback_id}`, with
`https://chatgpt.com/connector_platform_oauth_redirect` as a legacy fallback.
Under DCR the client registers its own redirect, so nothing is hardcoded here.

---

## Cloudflare: do NOT clone the Anthropic rule

The Claude connector's WAF rule skips bot protection for Anthropic's egress
range `160.79.104.0/21` on `/api/mcp` and `/.well-known/*`. **That shape does
not transfer.** OpenAI publishes ~270 CIDRs at
`https://openai.com/chatgpt-connectors.json` and regenerates the file
frequently, so it cannot be pinned in a WAF expression.

Worse, this is a trap we have already hit: the Jul 2026 `ofid_…` outage was
Cloudflare's `ai_bots_protection = "block"` rejecting the `Claude-User` user
agent regardless of path, and `GPTBot` / `ChatGPT-User` are on the same list.

**Recommended rule: condition on path, not IP.**

```
(http.request.uri.path in {"/api/mcp" "/api/mcp/chatgpt"}
 or starts_with(http.request.uri.path, "/.well-known/"))
-> Skip: Super Bot Fight Mode, all managed rulesets, Browser Integrity Check, UA blocks
```

Bot protection buys nothing on these paths: every meaningful request carries a
bearer that must verify against Supabase, and every unauthenticated one gets a
cheap 401. OAuth is the control, not Cloudflare. Free-plan Bot Fight Mode
ignores skip rules entirely and must stay OFF.

Compensating controls, all three:

1. Cloudflare rate limit on `/api/mcp*`, ~120 req/min per `ip.src`
   (`mitigation_timeout: 10`; rate limiting cannot use `managed_challenge`, per
   `docs/OPS-MARKETING-SCRAPE-WAF.md`).
2. The app-level per-user limiter in `src/lib/mcp/server.ts`.
3. The JWT-shape pre-check, so an unauthenticated flood does not cost a
   Supabase round trip per request.

**Real ChatGPT traffic is getting through today.** The live connection above
means OpenAI's egress is not being blocked on `/api/mcp` right now.

That is luck rather than design, and the reason to still do the rule change:
the existing skip is conditioned on **Anthropic's** IP range, so ChatGPT is
passing on default bot scoring rather than on an explicit allowance. A
reputation shift, a new managed rule, or a Bot Fight Mode toggle would take it
out with no warning and no origin trace.

### The change, ready to apply

Zone `newcoworker.com`, custom firewall ruleset
`f9a51022c3c24b5baa8c8e8ac33f5d8f`. **Add** this rule; do NOT delete the
existing "MCP connector allowlist" until the new one is verified, so there is
never a window with no skip in place.

- **Name:** `MCP endpoints: skip bot protection`
- **Expression:**

```
(http.request.uri.path in {"/api/mcp" "/api/mcp/chatgpt"} or starts_with(http.request.uri.path, "/.well-known/"))
```

- **Action:** Skip
- **Skip:** Super Bot Fight Mode, all managed rulesets, Browser Integrity
  Check, and any User Agent block rules.

Then the rate limit:

- **Expression:** `starts_with(http.request.uri.path, "/api/mcp")`
- **Characteristics:** `ip.src`
- **Rate:** 120 requests per 60 seconds
- **Action:** Block, `mitigation_timeout: 10`

Confirm the zone's **Block AI bots** setting stays off for these paths, and that
free-plan **Bot Fight Mode** is off entirely, since it runs before WAF rules and
ignores skips.

**Verify after applying**, from off-network. 401 is correct (unauthenticated,
but reaching the origin); 403 means the edge is still blocking, and Cloudflare
Security, Events will name the rule:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://www.newcoworker.com/api/mcp/chatgpt \
  -H 'content-type: application/json' \
  -H 'user-agent: Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)' -d '{}'
```

### Second Cloudflare item: the listing pages themselves

The submission's **Documentation URL** and the reviewer test plan are fetched by
OpenAI during review, and the zone currently **403s a request that sends no
`Accept-Language` header** (the Jul 2026 scraper rule, see
`docs/OPS-MARKETING-SCRAPE-WAF.md`). A browser always sends one; an automated
validator may not.

```bash
# 403 today. Should be 200 before submitting.
curl -s -o /dev/null -w "%{http_code}\n" https://www.newcoworker.com/integrations/chatgpt

# 200, because curl was given the header a browser would send.
curl -s -o /dev/null -w "%{http_code}\n" -H 'Accept-Language: en-US,en;q=0.9' \
  https://www.newcoworker.com/integrations/chatgpt
```

Pre-existing zone behavior rather than something the ChatGPT pages introduced
(`/integrations/slack` behaves the same). It matters here because a rejection
would read as "documentation URL unreachable" with **nothing in the origin
logs**, the same zero-trace signature as the connector outage. A `ChatGPT-User`
agent WITH the header already gets 200, so the user agent is not the problem.

**Failure signatures**, unchanged from the Claude incident: "Couldn't connect"
means an unauthenticated probe was blocked; an `ofid_…` error means OAuth
succeeded and the verification POST 403'd at the edge with zero origin trace.
Check Cloudflare Security, Events before suspecting the app.

---

## Rollout order

1. Set `OPENAI_APPS_CHALLENGE_TOKEN` in Vercel and confirm
   `/.well-known/openai-apps-challenge` serves it.
2. Apply the path-conditioned WAF rule; keep the Anthropic rule until the new
   one is verified.
3. Add the connector in **ChatGPT Developer Mode** (Settings, Connectors,
   Advanced; a **paid** ChatGPT plan is required, the UI does not work on Free)
   against `https://www.newcoworker.com/api/mcp/chatgpt` and exercise OAuth,
   `tools/list`, `search`, `fetch`, and a write.
4. Verify with MCP Inspector (`npx @modelcontextprotocol/inspector`) that
   titles, annotations, and output schemas render as a client sees them.
5. Prepare the demo tenant (below), then submit.

---

## Submission checklist (platform.openai.com/plugins)

- [ ] Verified developer or business identity on the OpenAI platform.
- [ ] Listing: name, short and long description, logo, category.
- [ ] URLs: website, support, **privacy**, **terms**. Both `/privacy` and
      `/terms` exist; confirm each names the ChatGPT app and what it accesses.
- [ ] Documentation URL points at `/integrations/chatgpt`.
- [ ] MCP server URL (Universal): `https://www.newcoworker.com/api/mcp/chatgpt`.
- [ ] Domain verification token placed and confirmed.
- [ ] Auth credentials plus a **demo account**: no MFA, email pre-confirmed,
      seeded with fake contacts, threads and calls, verified from a fresh
      incognito window. **Credentials go in the password manager and the
      submission form, never in the repo or in this file.**
- [ ] Content security policy for any UI component domains.
- [ ] Tool annotations present on every tool (CI-guarded).
- [ ] Starter prompts showing realistic workflows.
- [ ] **Five positive** test cases (prompt, expected behavior, result shape,
      test data) and **three negative** ones (prompt, expected refusal or
      fallback, justification).
- [ ] Country availability: only where the publisher, support process and
      legal terms are ready.
- [ ] Release notes and policy attestations.

### Data-handling rules that shape our responses

Collect only what the task needs; no "just in case" fields, no full
conversation history, and no restricted data (payment details, health records,
government IDs, credentials). Responses must not carry diagnostic metadata,
session ids or trace ids. The metadata guard rejects an output schema whose
keys look like diagnostics.

### Publishing states

Draft, Under Review, Approved, Published, then visible in the directory.
Changing the MCP snapshot means rescanning the server, submitting a new version
for review, and publishing the approved one.

---

## Config freeze

Once submitted, treat the tool set, the tool names, and the annotations as
frozen until the review completes. A reviewer tests the snapshot they scanned;
changing it mid-review is what got the July 2026 Zoom update bounced (README
"Zoom OAuth: two clients, one app").

At publish time, flip the dashboard card copy from "paste this URL into
Developer Mode" to "install from the ChatGPT directory". Before approval the
pasted URL is the only install path; after it, most users never see a URL.

---

## Known gaps, before submission

- **Outbound attribution: fixed.** Sends carry `mcp_chatgpt` or `mcp`, and the
  thread view labels each correctly.
- **Inline UI components: built.** Three widgets (open times, contact card,
  conversation) on `calendar_find_slots`, `get_contact` and `get_sms_thread`.
  Self-contained documents under `ui://`, so the CSP below is genuinely empty.
- **Audience is unverified**, as above.

---

## The submission form, answered

Everything below is ready to paste. The three items only you can do are marked
**YOU**.

| Field | Value |
| --- | --- |
| Plugin name | New Coworker |
| Short description | Your AI coworker: look up customers, read texts and calls, send messages, and book appointments. |
| MCP server URL (Universal) | `https://www.newcoworker.com/api/mcp/chatgpt` |
| Website | `https://www.newcoworker.com` |
| Documentation | `https://www.newcoworker.com/integrations/chatgpt` |
| Reviewer test plan | `https://www.newcoworker.com/integrations/chatgpt/review-test-plan` |
| Privacy policy | `https://www.newcoworker.com/privacy` |
| Terms | `https://www.newcoworker.com/terms` |
| Category | Productivity / Business |
| Authentication | OAuth 2.1, dynamic client registration, PKCE S256 |
| CSP: connectDomains | (none) |
| CSP: resourceDomains | (none) |
| Logo | **YOU** (PNG, 256x256 or larger, max 10 KB) |
| Verified developer identity | **YOU** |
| Demo account credentials | **YOU** (see below) |

### Starter prompts

1. What is going on with my business today?
2. Find the customer I texted about a quote last week.
3. Show me my conversation with [customer name].
4. What open times do I have on Thursday?
5. Summarize my recent calls.

### Five positive test cases

| Prompt | Expected |
| --- | --- |
| List my businesses on New Coworker | Names the demo business with plan and role |
| Search for Maria | Returns the contact and their conversation, each with a dashboard link |
| Show me my text conversation with Maria | Renders the conversation widget, oldest first |
| What appointment times are open on Thursday? | Renders the open-times widget with selectable slots |
| Text Maria that we can fit her in Thursday at 2pm | **Confirms first**, then sends and reports the result |

### Three negative test cases

| Prompt | Expected | Why |
| --- | --- | --- |
| Delete all my customers | Refusal: no such tool exists | Destructive bulk operations are deliberately not exposed |
| Show me the contacts for [a business the account cannot access] | Refusal naming the permission, without confirming whether that business exists | Authorization is per business per call, and refusals must not leak existence |
| Text every customer I have a discount code | Refusal or a request to narrow it | There is no bulk-send tool, and the per-business rate limit backs that up |

### The demo account (YOU)

Requirements from the guidelines, all of which cause rejection if missed:

- works with **no MFA**, no email confirmation, no private network,
- **email pre-confirmed**, so a reviewer never sees a verification wall,
- seeded with believable but fake contacts, conversations and calls,
- the business's outbound number points somewhere we control, so a reviewer
  testing a send does not text a real person,
- a **second login on the same business with the staff role**, for step 4 of
  the test plan, which is where a reviewer sees permissions actually enforced.

Verify it end to end from a fresh incognito window before submitting.
**Credentials go in the password manager and the submission form. Never in this
repo.**
