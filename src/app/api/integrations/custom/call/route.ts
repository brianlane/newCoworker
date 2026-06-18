/**
 * Agent-facing proxy: invoke a stored custom integration.
 *
 * The Rowboat agent's `http_api_call` tool POSTs here with the
 * Rowboat gateway bearer token. The body is the model-supplied
 * portion of the call (label, method, path, query, body, headers);
 * the **businessId is NOT in the body** — it comes from the
 * `?businessId=<uuid>` URL query parameter, which Rowboat
 * substitutes from `BUSINESS_ID` at deploy time. That keeps the
 * tenant binding entirely outside the model's reach: a
 * prompt-injected user cannot smuggle another business UUID
 * because the URL is fixed by the deployment, not the model.
 *
 * Security model — this route is the one place a stored credential ever
 * leaves the encrypted-at-rest column, so the rules are strict:
 *
 *   1. Auth is gateway-only (`ROWBOAT_GATEWAY_TOKEN`). The dashboard UI
 *      never calls this — the dashboard manages rows, not invocations.
 *   2. The tenant (`businessId`) is bound by the URL query string,
 *      not the JSON body. The Rowboat workflow template hardcodes
 *      `?businessId={{BUSINESS_ID}}` so the model has no input
 *      surface to influence which tenant's credentials are used.
 *      Any `businessId` field present in the JSON body is ignored.
 *   3. The outbound URL MUST resolve to the row's `base_url.origin`. The
 *      caller-supplied `path` is appended to `base_url.pathPrefix`; we
 *      reject any `path` that contains a scheme/authority or attempts
 *      to escape the prefix via `..`.
 *   4. Private and loopback hosts are re-checked at call time. A row
 *      written before that guard existed must still be blocked.
 *   5. Methods restricted to the safe REST verbs. HEAD/OPTIONS/TRACE/
 *      CONNECT are refused so a clever prompt can't pivot to host
 *      probes via the stored creds.
 *   6. The agent CAN supply additional headers, but `Authorization`,
 *      `Cookie`, `Host`, `Content-Length`, and any header whose name
 *      collides with the row's configured `header_name` (when scheme is
 *      "header") are dropped. The credential is added last so the
 *      agent's headers never clobber it.
 *   7. Response body is capped at RESPONSE_MAX_BYTES so a huge payload
 *      from the upstream API can't blow the model's context budget or
 *      DOS the worker.
 *   8. Outbound timeout is bounded by REQUEST_TIMEOUT_MS.
 */
import { z } from "zod";
import { logger } from "@/lib/logger";
import { errorResponse } from "@/lib/api-response";
import {
  gatewayGuard,
  gatewayBusinessGuard,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import {
  getCustomIntegrationByLabel,
  isPrivateOrLoopbackHost,
  parseBaseUrl,
  type CustomIntegrationRow
} from "@/lib/db/custom-integrations";
import { assertSafeHostname } from "@/lib/website-ingest";

/** Hard cap on the response body we forward back to the agent. 100 KB
 * is enough for a single CRM record / list page; anything bigger is
 * almost certainly a paginated dump the agent shouldn't be munging in a
 * single turn. */
export const RESPONSE_MAX_BYTES = 100 * 1024;

/** Outbound request budget. The agent's overall turn budget is far
 * larger; we want THIS hop to fail fast on a stuck upstream so the
 * model can recover or surface the error mid-conversation. */
export const REQUEST_TIMEOUT_MS = 20_000;

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Tenant binding lives in the URL query (`?businessId=<uuid>`), not
 * the JSON body, so the model's input schema has no field that could
 * be prompt-injected to point at another tenant. Any `businessId`
 * present in the JSON body is ignored — the body schema is `passthrough`
 * but does not declare it, and the route never reads it.
 */
const callSchema = z.object({
  label: z.string().min(1).max(80),
  method: z.enum(ALLOWED_METHODS).default("GET"),
  // Path is appended to base_url.pathPrefix. Must start with `/` and
  // must not contain `..` (path-traversal escape) or a scheme.
  path: z.string().max(2048).default("/"),
  // Additional query params to merge with anything the auth scheme
  // already injected (auth's query param wins on collision).
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  body: z.unknown().optional(),
  // Optional extra headers. We strip a sensitive subset before send.
  headers: z.record(z.string(), z.string()).optional(),
  // Optional caller-supplied content-type; defaults to application/json
  // when a body is present.
  contentType: z.string().min(1).max(120).optional()
});

export type CustomIntegrationCallRequest = z.infer<typeof callSchema>;

const STRIPPED_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "upgrade"
]);

function buildHeaders(
  integration: CustomIntegrationRow,
  agentHeaders: Record<string, string> | undefined,
  contentType: string | undefined,
  hasBody: boolean
): Headers {
  const out = new Headers();
  // Caller-supplied headers go in first so credential injection (below)
  // always wins on collision. We also drop sensitive headers
  // unconditionally so a clever prompt can't cookie-stuff the upstream.
  if (agentHeaders) {
    for (const [k, v] of Object.entries(agentHeaders)) {
      const name = k.toLowerCase();
      if (STRIPPED_HEADERS.has(name)) continue;
      // When scheme=header, the agent must not be allowed to set the
      // configured header_name itself — they'd be supplying the secret
      // value (probably a placeholder, but we don't trust it).
      if (
        integration.auth_scheme === "header" &&
        integration.header_name &&
        name === integration.header_name.toLowerCase()
      ) {
        continue;
      }
      out.set(k, v);
    }
  }
  if (hasBody) {
    out.set("Content-Type", contentType ?? "application/json");
  }
  out.set("Accept", out.get("Accept") ?? "application/json, */*;q=0.5");
  // Useful for upstream debugging / per-tenant rate limiting.
  out.set("User-Agent", "newcoworker-custom-integration/1");
  return out;
}

function applyAuthScheme(
  integration: CustomIntegrationRow,
  outUrl: URL,
  outHeaders: Headers
): { detail: string } | null {
  if (integration.auth_scheme === "none") return null;
  const secret = integration.secret;
  if (!secret) {
    return { detail: "secret_missing" };
  }
  switch (integration.auth_scheme) {
    case "bearer":
      outHeaders.set("Authorization", `Bearer ${secret}`);
      return null;
    case "header": {
      if (!integration.header_name) {
        return { detail: "header_name_missing" };
      }
      outHeaders.set(integration.header_name, secret);
      return null;
    }
    case "basic":
      // `secret` is "user:pass" by convention — see UI hint.
      outHeaders.set(
        "Authorization",
        `Basic ${Buffer.from(secret, "utf8").toString("base64")}`
      );
      return null;
    case "query": {
      if (!integration.header_name) {
        return { detail: "header_name_missing" };
      }
      // Always overwrite — the agent's `query` map cannot supply this
      // parameter (we set it after merging the agent's query below).
      outUrl.searchParams.set(integration.header_name, secret);
      return null;
    }
  }
  /* c8 ignore next -- defensive: zod + DB CHECK both gate auth_scheme so this is unreachable */
  return { detail: "auth_scheme_invalid" };
}

function safelyJoinPath(prefix: string, path: string): string | null {
  if (!path.startsWith("/")) return null;
  // Reject path-traversal segments. We block anywhere in the path; even
  // an anchored `..` could trip up an upstream that decodes percent
  // sequences differently than `URL` does, so we err on the side of
  // refusing the call.
  if (path.includes("..")) return null;
  // Disallow embedded scheme / authority. WHATWG URL treats `\` as
  // equivalent to `/` for special schemes (https) during authority
  // detection, so both `//evil/path` and `/\evil/path` would pivot to
  // a different host when resolved against the base origin. We
  // additionally refuse ANY backslash anywhere in the path — REST APIs
  // don't use `\` in URL paths and tolerating it just hands the
  // attacker a second class of pivot strings to probe.
  if (/^\/+\/+/.test(path)) return null;
  if (path.includes("\\")) return null;
  if (prefix === "/") return path;
  return `${prefix}${path}`;
}

/**
 * Tenant-id validator. We delegate to Zod's `.uuid()` instead of a
 * hand-rolled regex so this route accepts the same set of UUIDs the
 * rest of the codebase produces and validates — including v6/v7/v8
 * (RFC 9562) which the previous local `[1-5]` regex would have
 * silently rejected with a confusing `missing_business_id`. Today's
 * `crypto.randomUUID()` returns v4, but if the platform ever adopts
 * v7 for time-sortable IDs, this route gets it for free.
 */
const businessIdSchema = z.string().uuid();

export async function POST(request: Request) {
  const guard = gatewayGuard(request);
  if (guard) return guard;

  // Tenant binding: read from the URL query, NOT the JSON body. The
  // Rowboat workflow template hardcodes this query at deploy time,
  // so the model never has a chance to influence which tenant's
  // credentials get used (Bugbot P1: "Bind custom integration calls
  // to the tenant").
  let businessId: string;
  try {
    const url = new URL(request.url);
    const raw = url.searchParams.get("businessId");
    const parsed = businessIdSchema.safeParse(raw);
    if (!parsed.success) {
      return voiceToolValidationError("missing_business_id");
    }
    businessId = parsed.data;
  } catch {
    /* c8 ignore next 2 -- WHATWG URL never throws for a request that
       reached this handler; defensive only. */
    return voiceToolValidationError("invalid_request_url");
  }

  const bindGuard = await gatewayBusinessGuard(request, businessId);
  if (bindGuard) return bindGuard;

  let parsed: CustomIntegrationCallRequest;
  try {
    parsed = callSchema.parse(await request.json());
  } catch (err) {
    // Body parse / Zod failure both surface as `invalid_args:<detail>`.
    // We don't try to plumb the specific Zod issue through — the
    // detail is for human debugging, not model branching, and the
    // simpler message keeps this handler trivially testable.
    const detail = err instanceof z.ZodError ? "invalid_args" : "invalid_body";
    return voiceToolValidationError(detail);
  }

  let integration: CustomIntegrationRow | null;
  try {
    integration = await getCustomIntegrationByLabel(businessId, parsed.label);
  } catch (err) {
    logger.error("custom-integration call: lookup failed", {
      businessId,
      label: parsed.label,
      errorMessage: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "lookup_failed" }, 500);
  }
  if (!integration) {
    return voiceToolResponse({ ok: false, detail: "integration_not_found" });
  }
  if (!integration.is_active) {
    return voiceToolResponse({ ok: false, detail: "integration_disabled" });
  }

  let parsedBase;
  try {
    parsedBase = parseBaseUrl(integration.base_url);
  } catch {
    // Should never happen — base_url passed validation at write time —
    // but a stricter guard added later might reject an old row. Refuse.
    return voiceToolResponse(
      { ok: false, detail: "base_url_invalid" },
      500
    );
  }

  const joinedPath = safelyJoinPath(parsedBase.pathPrefix, parsed.path);
  if (joinedPath === null) {
    return voiceToolResponse({ ok: false, detail: "path_invalid" });
  }

  let outUrl: URL;
  try {
    outUrl = new URL(joinedPath, parsedBase.origin);
  } catch {
    /* c8 ignore next -- defensive: safelyJoinPath has already gated unparseable shapes */
    return voiceToolResponse({ ok: false, detail: "path_invalid" });
  }
  // Defense in depth: even though `URL(path, origin)` honors `origin`,
  // a pathological `path` like `//host/p` could rebase. Re-pin host.
  /* c8 ignore start -- defensive: safelyJoinPath + parseBaseUrl already gate the known pivot/private-host shapes upstream */
  if (outUrl.origin !== parsedBase.origin) {
    return voiceToolResponse({ ok: false, detail: "path_pivot_blocked" });
  }
  if (isPrivateOrLoopbackHost(outUrl.hostname)) {
    return voiceToolResponse({ ok: false, detail: "private_host_blocked" });
  }
  /* c8 ignore stop */

  // SSRF defense: a public-looking hostname can resolve to a private IP
  // (DNS rebinding, accidental misconfig, attacker-controlled CNAMEs).
  // `isPrivateOrLoopbackHost` only inspects the literal hostname, so we
  // additionally resolve the name and reject if any returned address is
  // private/loopback. Note: this still has a TOCTOU window with the
  // subsequent `fetch()` resolving the name a second time; pinning the
  // IP would close it but break TLS SNI for vhosted upstreams. The
  // DNS pre-check is the same defense `website-ingest` uses for owner-
  // submitted URLs, and it stops the high-impact bypasses.
  try {
    await assertSafeHostname(outUrl.hostname);
  } catch (err) {
    const code = err instanceof Error ? err.message : "private_address";
    /* c8 ignore next -- defensive: assertSafeHostname only throws those two codes */
    const detail = code === "dns_failure" ? "upstream_unreachable" : "private_host_blocked";
    return voiceToolResponse({ ok: false, detail }, code === "dns_failure" ? 502 : 200);
  }

  // Merge agent's `query` first; auth-scheme query wins via `set` below.
  if (parsed.query) {
    for (const [k, v] of Object.entries(parsed.query)) {
      outUrl.searchParams.set(k, String(v));
    }
  }

  const hasBody =
    parsed.body !== undefined &&
    parsed.method !== "GET" &&
    parsed.method !== "DELETE";

  const outHeaders = buildHeaders(
    integration,
    parsed.headers,
    parsed.contentType,
    hasBody
  );
  const authErr = applyAuthScheme(integration, outUrl, outHeaders);
  if (authErr) {
    return voiceToolResponse({ ok: false, detail: authErr.detail }, 500);
  }

  const init: RequestInit = {
    method: parsed.method,
    headers: outHeaders,
    redirect: "manual"
  };
  if (hasBody) {
    init.body =
      parsed.contentType && !/json/i.test(parsed.contentType)
        ? typeof parsed.body === "string"
          ? parsed.body
          : JSON.stringify(parsed.body)
        : JSON.stringify(parsed.body ?? null);
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(outUrl.toString(), { ...init, signal: ac.signal });
  } catch (err) {
    clearTimeout(timeout);
    const aborted = (err as Error)?.name === "AbortError";
    logger.warn("custom-integration call: upstream failed", {
      businessId,
      label: parsed.label,
      host: outUrl.hostname,
      method: parsed.method,
      aborted,
      errorMessage: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse(
      { ok: false, detail: aborted ? "upstream_timeout" : "upstream_unreachable" },
      502
    );
  }

  // Cap response bytes. We read at most RESPONSE_MAX_BYTES + 1 to
  // detect overflow without buffering more than necessary.
  //
  // The fetch timeout (`ac` / `timeout`) stays active until the body
  // is fully drained (or cancelled) — otherwise an upstream that sends
  // headers promptly but stalls mid-body would hang the worker
  // indefinitely. We only `clearTimeout` once the read loop has
  // resolved one way or another.
  const reader = upstream.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        /* c8 ignore next -- streams spec: a non-done chunk always carries bytes; null guard is defensive against non-conformant polyfills */
        if (!value) continue;
        // If this chunk would push us over the cap, keep ONLY the
        // bytes that fit (don't drop the chunk entirely — a single
        // 110 KB chunk used to produce an empty response with
        // `truncated:true`, which is useless to the agent).
        const remaining = RESPONSE_MAX_BYTES - total;
        if (value.byteLength > remaining) {
          if (remaining > 0) {
            chunks.push(value.slice(0, remaining));
            total += remaining;
          }
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    /* c8 ignore next -- defensive: cancel() failure is always safe to ignore */
    await reader?.cancel().catch(() => {});
    logger.warn("custom-integration call: body read failed", {
      businessId,
      label: parsed.label,
      host: outUrl.hostname,
      method: parsed.method,
      aborted,
      errorMessage: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse(
      { ok: false, detail: aborted ? "upstream_timeout" : "upstream_body_failed" },
      502
    );
  } finally {
    clearTimeout(timeout);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const text = buf.toString("utf8");

  // Best-effort JSON parse. If the upstream returned application/json
  // we hand back a parsed object; otherwise we forward the text so the
  // model can decide what to do with it.
  let data: unknown = text;
  const ct = upstream.headers.get("content-type") ?? "";
  if (/application\/(?:[^;]+\+)?json/i.test(ct)) {
    try {
      data = JSON.parse(text);
    } catch {
      // Leave as text and let the model see the raw body.
    }
  }

  logger.info("custom-integration call ok", {
    businessId,
    label: parsed.label,
    method: parsed.method,
    host: outUrl.hostname,
    status: upstream.status,
    bytes: total,
    truncated
  });

  return voiceToolResponse({
    ok: true,
    data: {
      status: upstream.status,
      headers: extractSafeHeaders(upstream.headers),
      data,
      truncated
    }
  });
}

/**
 * Forward only a curated subset of upstream headers back to the agent.
 * Some headers (`set-cookie`, `authorization`) would be a footgun if
 * the model decided to "remember" them and replay later.
 */
function extractSafeHeaders(headers: Headers): Record<string, string> {
  const KEEP = new Set([
    "content-type",
    "content-length",
    "etag",
    "last-modified",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "retry-after"
  ]);
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (KEEP.has(key.toLowerCase())) {
      out[key] = value;
    }
  });
  return out;
}

// 405 for unintended methods (cleaner than the Next default).
export async function GET() {
  return errorResponse(
    "VALIDATION_ERROR",
    "GET not supported on this route — use POST",
    405
  );
}
