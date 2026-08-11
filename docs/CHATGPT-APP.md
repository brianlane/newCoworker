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
| ChatGPT endpoint | `src/app/api/mcp/chatgpt/route.ts` |
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

**Supabase accepts the `resource` parameter** (an authorize request carrying it
behaves identically to one without it), so the blocking outcome is ruled out.
Whether it **binds** the value into the token's `aud` is only visible in the
token itself and needs a browser consent to finish; see the probe's usage
block. If it does not bind, we publish the correct `resource` in our metadata,
verify `iss` exactly, and document the gap rather than building an
authorization-server shim.

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

A probe from off-network currently returns **401, not 403**, for a
`ChatGPT-User` user agent on `/api/mcp`. Encouraging but not proof: real
traffic arrives from OpenAI's egress IPs, and Cloudflare scores more than the
UA string.

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
   Advanced) against `https://www.newcoworker.com/api/mcp/chatgpt` and exercise
   OAuth, `tools/list`, `search`, `fetch`, and a write.
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
