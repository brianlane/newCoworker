/**
 * Does our OAuth setup satisfy what ChatGPT asks of an MCP server?
 *
 * ChatGPT sends RFC 8707 `resource=https://<our-mcp>` on BOTH the authorize
 * and the token request, and expects the authorization server to copy it into
 * the token's `aud` claim so the resource server can prove the token was
 * minted for it and not for some other API on the same issuer.
 *
 * Supabase Auth is our authorization server and we cannot change its
 * behavior, so its handling of that parameter decides how much of the ChatGPT
 * work is possible. Three outcomes, and the plan branches on which one this
 * script reports:
 *
 *   COPIES   Supabase echoes `resource` into `aud`. Enforce the audience in
 *            verifySupabaseAccessToken.
 *   IGNORES  Supabase accepts and drops it (expected: Supabase historically
 *            mints `aud: "authenticated"`). Publish the right `resource` in
 *            our metadata, verify `iss` exactly, document the gap.
 *   REJECTS  Supabase 400s the unknown parameter. Hard blocker; the escape
 *            hatch is a thin authorization-server shim in front of it.
 *
 * It also prints what each of our two protected-resource metadata endpoints
 * claims as its `resource`, because mcp-handler derives that from the request
 * path and the two therefore disagree today (the root copy names the bare
 * origin rather than /api/mcp).
 *
 * READ-ONLY against our own infrastructure, with one exception called out
 * below: step 2 creates an OAuth client via dynamic client registration,
 * which is a write to Supabase's client registry. That is the only way to get
 * an authorize URL at all, DCR is open by design here (README: "exposure is
 * equivalent to the login page"), and the script prints the created client id
 * so it can be deleted afterwards. Pass --skip-dcr to stop before it.
 *
 * Usage:
 *   npx tsx debug/mcp-oauth-resource-probe.ts
 *   npx tsx debug/mcp-oauth-resource-probe.ts --skip-dcr
 *   npx tsx debug/mcp-oauth-resource-probe.ts --code <code> --verifier <v> --client-id <id>
 *
 * The third form completes the flow: run the plain form, open the printed
 * authorize URL in a browser, approve, then copy the `code` out of the
 * redirect (the redirect host is chatgpt.com and will 404, which is fine and
 * expected) and re-run with it to see the decoded token claims.
 */
import { createHash, randomBytes } from "node:crypto";
import { loadEnv } from "./_shared.ts";

loadEnv();

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://www.newcoworker.com")
  .trim()
  .replace(/\/+$/, "");

if (!SUPABASE_URL) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL (checked the repo .env).");
  process.exit(1);
}

const ISSUER = `${SUPABASE_URL}/auth/v1`;
/** The canonical id ChatGPT would use for the future /api/mcp/chatgpt route. */
const RESOURCE = `${APP_URL}/api/mcp/chatgpt`;
/** ChatGPT's real production redirect shape, so we probe what it would probe. */
const REDIRECT_URI = "https://chatgpt.com/connector/oauth/probe";

const section = (title: string): void => console.log(`\n=== ${title} ===`);
const show = (label: string, value: unknown): void =>
  console.log(`  ${label.padEnd(38)} ${typeof value === "string" ? value : JSON.stringify(value)}`);

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text.slice(0, 400) };
  }
}

/** Decode a JWT payload without verifying. We only want to read the claims. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Step 1: what does Supabase advertise about itself? */
async function probeAuthorizationServerMetadata(): Promise<Record<string, unknown> | null> {
  section("1. Supabase authorization-server metadata (RFC 8414)");
  const url = `${ISSUER}/.well-known/oauth-authorization-server`;
  show("url", url);
  const { status, body } = await getJson(url);
  show("status", status);
  if (status !== 200 || typeof body !== "object" || body === null) {
    show("body", body);
    console.log("  -> No AS metadata. ChatGPT cannot discover the issuer; this is a blocker.");
    return null;
  }
  const meta = body as Record<string, unknown>;
  for (const key of [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
    "userinfo_endpoint",
    "code_challenge_methods_supported",
    "scopes_supported",
    "token_endpoint_auth_methods_supported",
    // The two that decide how much work the ChatGPT side is.
    "resource_parameter_supported",
    "client_id_metadata_document_supported"
  ]) {
    show(key, key in meta ? meta[key] : "(absent)");
  }

  const pkce = meta.code_challenge_methods_supported;
  if (!Array.isArray(pkce) || !pkce.includes("S256")) {
    console.log("  -> WARNING: S256 PKCE not advertised. ChatGPT requires it.");
  }
  if (!meta.registration_endpoint) {
    console.log("  -> WARNING: no registration_endpoint. Dynamic client registration looks off.");
  }
  if (!meta.userinfo_endpoint) {
    console.log(
      "  -> Note: no OIDC userinfo endpoint advertised, so ChatGPT Enterprise workspace"
    );
    console.log("     domain verification is out of reach. Consumer/Team installs are unaffected.");
  }
  return meta;
}

/** Step 2: register a throwaway client, the way ChatGPT would. */
async function registerClient(meta: Record<string, unknown>): Promise<string | null> {
  section("2. Dynamic client registration (RFC 7591)");
  const endpoint = typeof meta.registration_endpoint === "string" ? meta.registration_endpoint : "";
  if (!endpoint) {
    console.log("  Skipped: no registration_endpoint advertised.");
    return null;
  }
  show("endpoint", endpoint);
  console.log("  NOTE: this WRITES a client to Supabase's registry. Delete it when done.");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "New Coworker resource probe (delete me)",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  const text = await res.text();
  show("status", res.status);
  if (!res.ok) {
    show("body", text.slice(0, 400));
    return null;
  }
  const body = JSON.parse(text) as Record<string, unknown>;
  const clientId = typeof body.client_id === "string" ? body.client_id : null;
  show("client_id", clientId ?? "(none returned)");
  show("client_id_issued_at", body.client_id_issued_at ?? "(absent)");
  return clientId;
}

/** One authorize attempt, reduced to the bits the comparison needs. */
type AuthorizeAttempt = {
  status: number;
  location: string;
  /** OAuth `error` code, from a JSON body or from the redirect query. */
  error: string;
  errorDescription: string;
  bodyPreview: string;
};

/**
 * Read the OAuth error out of a response, from either shape an authorization
 * server may use: a 400 with a JSON body, or a 302 back to redirect_uri
 * carrying `?error=...&error_description=...` (RFC 6749 section 4.1.2.1 sends
 * errors that way once the client and redirect are themselves valid).
 */
function readOAuthError(
  status: number,
  location: string,
  text: string
): { error: string; errorDescription: string } {
  if (location) {
    try {
      const q = new URL(location).searchParams;
      const error = q.get("error") ?? "";
      if (error) return { error, errorDescription: q.get("error_description") ?? "" };
    } catch {
      // Relative or malformed Location: fall through to the body.
    }
  }
  if (status >= 400) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const str = (key: string): string =>
        typeof body[key] === "string" ? (body[key] as string) : "";
      // Supabase answers with its own `{code, error_code, msg}` shape rather
      // than RFC 6749's `{error, error_description}`, so read both. Without
      // the fallback the report prints "(none)" next to a real refusal and
      // an `invalid_target` would be invisible.
      return {
        error: str("error") || str("error_code"),
        errorDescription: str("error_description") || str("msg")
      };
    } catch {
      // Non-JSON error body (an HTML error page). The preview still shows it.
    }
  }
  return { error: "", errorDescription: "" };
}

/** Issue one authorize request, optionally carrying `resource`. */
async function authorizeAttempt(
  endpoint: string,
  clientId: string,
  challenge: string,
  withResource: boolean
): Promise<AuthorizeAttempt> {
  const url = new URL(endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", randomBytes(8).toString("hex"));
  if (withResource) url.searchParams.set("resource", RESOURCE);

  // `manual` so a 302 to the consent page reads as acceptance rather than
  // being followed into an HTML login page we would have to parse.
  const res = await fetch(url, { redirect: "manual" });
  const text = await res.text();
  const location = res.headers.get("location") ?? "";
  return {
    status: res.status,
    location,
    ...readOAuthError(res.status, location, text),
    bodyPreview: text.slice(0, 400)
  };
}

/**
 * Step 3: does the authorize endpoint tolerate `resource`?
 *
 * Answered by DIFFERENCE, not by status code alone. An authorization server
 * returns 400 for a bad client id, a redirect URI that does not match the
 * registration, an unsupported scope, a malformed PKCE challenge, and plenty
 * else, so reading any 400 as "it refused `resource`" would print the one
 * blocking verdict for an unrelated cause and send us building an
 * authorization-server shim we never needed.
 *
 * So we send the same request twice, identical but for the parameter under
 * test. Only a failure that appears WITH `resource` and not without it is
 * evidence about `resource`. RFC 8707 names `invalid_target` for exactly this
 * refusal, which upgrades the verdict from inferred to confirmed.
 */
async function probeAuthorize(
  meta: Record<string, unknown>,
  clientId: string
): Promise<{ verifier: string; url: string } | null> {
  section("3. Authorize request carrying RFC 8707 resource");
  const endpoint =
    typeof meta.authorization_endpoint === "string" ? meta.authorization_endpoint : "";
  if (!endpoint) {
    console.log("  Skipped: no authorization_endpoint advertised.");
    return null;
  }

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const control = await authorizeAttempt(endpoint, clientId, challenge, false);
  const test = await authorizeAttempt(endpoint, clientId, challenge, true);

  const report = (label: string, a: AuthorizeAttempt): void => {
    console.log(`  ${label}`);
    show("  status", a.status);
    show("  location", a.location || "(none)");
    show("  error", a.error || "(none)");
    if (a.errorDescription) show("  error_description", a.errorDescription);
  };
  report("without resource (control)", control);
  report("with resource (test)", test);

  const failed = (a: AuthorizeAttempt): boolean => a.status >= 400 || a.error !== "";

  if (failed(test) && !failed(control)) {
    console.log("\n  -> VERDICT: REJECTS. The request succeeds without `resource` and fails");
    console.log("     with it, so the parameter is the difference.");
    if (test.error === "invalid_target") {
      console.log("     Confirmed by the RFC 8707 error code `invalid_target`.");
    }
    console.log("     This is the blocking outcome. See the plan's authorization-server shim.");
    if (!test.error) show("  body", test.bodyPreview);
    return null;
  }

  if (failed(test) && failed(control)) {
    console.log("\n  -> INCONCLUSIVE. Both attempts failed the same way, so this says");
    console.log("     nothing about `resource`. Fix the underlying request first: the");
    console.log("     usual causes are a stale client id, a redirect URI that does not");
    console.log("     match the registration, or an unsupported scope.");
    if (!test.error) show("  body", test.bodyPreview);
    return null;
  }

  console.log("\n  -> Supabase accepted the request with `resource` present.");
  console.log("     Whether it BINDS it is only visible in the token (step 4).");
  show("verifier (save this)", verifier);

  const url = new URL(endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", randomBytes(8).toString("hex"));
  url.searchParams.set("resource", RESOURCE);
  console.log("\n  Open this URL in a signed-in browser, approve, then copy the `code`");
  console.log("  out of the chatgpt.com redirect (that page 404s, which is expected):\n");
  console.log(`  ${url.toString()}\n`);
  return { verifier, url: url.toString() };
}

/** Step 4: exchange a code and read the audience out of the token. */
async function probeToken(
  meta: Record<string, unknown>,
  clientId: string,
  code: string,
  verifier: string
): Promise<void> {
  section("4. Token exchange, and the audience it mints");
  const endpoint = typeof meta.token_endpoint === "string" ? meta.token_endpoint : "";
  if (!endpoint) {
    console.log("  Skipped: no token_endpoint advertised.");
    return;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE
    })
  });
  const text = await res.text();
  show("status", res.status);
  if (!res.ok) {
    show("body", text.slice(0, 400));
    console.log("  -> Token exchange failed. If the error names `resource`, the verdict is REJECTS.");
    return;
  }

  const body = JSON.parse(text) as Record<string, unknown>;
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  show("token_type", body.token_type ?? "(absent)");
  show("scope", body.scope ?? "(absent)");
  const claims = accessToken ? decodeJwtPayload(accessToken) : null;
  if (!claims) {
    console.log("  -> Access token is not a readable JWT; audience cannot be inspected here.");
    return;
  }
  show("iss", claims.iss ?? "(absent)");
  show("aud", claims.aud ?? "(absent)");
  show("role", claims.role ?? "(absent)");
  show("sub", claims.sub ?? "(absent)");

  const aud = claims.aud;
  const audMatches = Array.isArray(aud) ? aud.includes(RESOURCE) : aud === RESOURCE;
  if (audMatches) {
    console.log("  -> VERDICT: COPIES. Supabase bound the resource into `aud`.");
    console.log("     Enforce expectedAudience in verifySupabaseAccessToken.");
  } else {
    console.log("  -> VERDICT: IGNORES. The resource did not reach `aud`.");
    console.log(`     aud is ${JSON.stringify(aud)}, expected ${RESOURCE}.`);
    console.log("     Publish the correct `resource` in our metadata and verify `iss` exactly.");
    if (aud === "authenticated") {
      console.log("     Also note: every project token shares this audience, so a dashboard");
      console.log("     session token is a valid MCP bearer. Status quo, worth writing down.");
    }
  }
}

/** Step 5: what do OUR two metadata endpoints claim to be? */
async function probeOurProtectedResourceMetadata(): Promise<void> {
  section("5. Our protected-resource metadata (RFC 9728)");
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/mcp"
  ]) {
    const { status, body } = await getJson(`${APP_URL}${path}`);
    console.log(`  ${path}`);
    show("  status", status);
    if (typeof body === "object" && body !== null) {
      const meta = body as Record<string, unknown>;
      show("  resource", meta.resource ?? "(absent)");
      show("  authorization_servers", meta.authorization_servers ?? "(absent)");
    } else {
      show("  body", body);
    }
  }
  console.log(`\n  Both should name the MCP endpoint, not the bare origin (${APP_URL}).`);
  console.log("  If the first one names the origin, that is the latent bug PR 3 fixes.");
}

async function main(): Promise<void> {
  console.log(`Issuer:   ${ISSUER}`);
  console.log(`App:      ${APP_URL}`);
  console.log(`Resource: ${RESOURCE}`);

  const meta = await probeAuthorizationServerMetadata();
  await probeOurProtectedResourceMetadata();
  if (!meta) return;

  const existingClientId = flag("client-id");
  const code = flag("code");
  const verifier = flag("verifier");

  if (code && verifier && existingClientId) {
    await probeToken(meta, existingClientId, code, verifier);
    return;
  }

  if (has("skip-dcr")) {
    console.log("\n--skip-dcr given: stopping before the client registration write.");
    return;
  }

  const clientId = existingClientId ?? (await registerClient(meta));
  if (!clientId) return;
  const authorize = await probeAuthorize(meta, clientId);
  if (!authorize) return;

  console.log("  Then finish the probe with:\n");
  console.log(
    `  npx tsx debug/mcp-oauth-resource-probe.ts --client-id ${clientId} --verifier ${authorize.verifier} --code <code>\n`
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
