/**
 * The direct (first-party OAuth) half of the workspace proxy.
 *
 * Given a base URL, a bearer token, and the same request shape the Nango
 * branch takes, this calls the provider itself. It is provider-agnostic: the
 * Microsoft client supplies `https://graph.microsoft.com`, and a later
 * Google-direct rollout supplies `https://www.googleapis.com` without touching
 * this file.
 *
 * IT MUST BE BEHAVIORALLY INDISTINGUISHABLE FROM `nango.proxy()`, because the
 * ~58 call sites are shared and cannot tell which transport served them. Four
 * details that are easy to get subtly wrong, all taken from what Nango's axios
 * client actually does:
 *
 * 1. QUERY MERGING. Params are merged onto the endpoint with
 *    `URL.searchParams.set`, so an endpoint that ALREADY carries a query
 *    string keeps it. Several callers build their own (`?$select=...`) and
 *    then pass `params` too.
 * 2. HEADERS ARRIVE BARE. Nango transmits custom headers as `Nango-Proxy-<k>`
 *    and its server strips the prefix before forwarding. Here there is no
 *    middleman, so `Prefer: outlook.timezone="UTC"` must be sent as-is.
 * 3. `data: {}` STILL SENDS A BODY. axios serializes an empty object to `{}`;
 *    treating it as "no body" makes Graph reject the call.
 * 4. AN EMPTY 204 BODY IS `""`, NOT `null`. That is axios's default
 *    `transformResponse`, and Graph 204s on event delete.
 *
 * Deliberately built on `fetch`, not axios. axios is only a devDependency in
 * this repo (it reaches production transitively through `@nangohq/node`), and
 * being able to drop `@nangohq/node` entirely is the point of the exercise. So
 * the error thrown here is duck-compatible with the axios shape rather than an
 * actual AxiosError: `proxyErrorResponse` in ./proxy.ts reads `.response.status`
 * and `.response.data`, which is exactly what this provides.
 */

import type { WorkspaceProxyResponse } from "./types";

/** Outbound budget per provider call. */
export const DIRECT_TRANSPORT_TIMEOUT_MS = 20_000;

export type DirectRequestSpec = {
  /** Provider-relative path, e.g. "/v1.0/me/sendMail". May carry its own query. */
  endpoint: string;
  method?: string;
  data?: unknown;
  params?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
};

/**
 * A non-2xx provider response, thrown to match the Nango branch.
 *
 * `response` is the axios-shaped payload `proxyErrorResponse` destructures, so
 * `workspaceProxyStatusForBusiness` can turn a 403 back into `{ status, data }`
 * for callers that branch on the code.
 */
export class DirectTransportError extends Error {
  public readonly response: { status: number; data: unknown };

  constructor(
    status: number,
    data: unknown,
    public readonly code:
      | "request_failed"
      | "upstream_timeout"
      | "upstream_unreachable" = "request_failed"
  ) {
    super(`Provider request failed (${status})`);
    this.name = "DirectTransportError";
    this.response = { status, data };
  }
}

/** A transport failure with no HTTP response at all (DNS, timeout, reset). */
export class DirectTransportUnreachable extends Error {
  constructor(
    public readonly code: "upstream_timeout" | "upstream_unreachable",
    message: string
  ) {
    super(message);
    this.name = "DirectTransportUnreachable";
  }
}

function buildUrl(
  baseUrl: string,
  endpoint: string,
  params: DirectRequestSpec["params"]
): string {
  // `endpoint` may already carry a query string; URL keeps it and
  // searchParams.set merges on top, matching Nango.
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}${endpoint}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Parses the body the way axios does by default: JSON when it parses, the raw
 * text otherwise, and `""` for an empty body (notably a 204).
 */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (text.length === 0) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Performs one authenticated provider request.
 *
 * Returns `{ status, data }` on 2xx. Throws `DirectTransportError` on any
 * other status (matching Nango, whose axios client has no `validateStatus`
 * override) and `DirectTransportUnreachable` when no response arrived at all.
 */
export async function directProviderRequest(
  baseUrl: string,
  accessToken: string,
  spec: DirectRequestSpec
): Promise<WorkspaceProxyResponse> {
  const method = (spec.method ?? "GET").toUpperCase();
  const url = buildUrl(baseUrl, spec.endpoint, spec.params);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    // Custom headers land unprefixed; see the module doc.
    ...(spec.headers ?? {})
  };

  // `data: {}` is a real body. Only an absent/undefined `data` means no body.
  const hasBody = spec.data !== undefined && method !== "GET" && method !== "HEAD";
  if (hasBody) headers["Content-Type"] = "application/json";

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), DIRECT_TRANSPORT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(spec.data) : undefined,
      signal: ac.signal
    });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw new DirectTransportUnreachable(
      aborted ? "upstream_timeout" : "upstream_unreachable",
      aborted ? "Provider request timed out" : "Provider unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }

  const data = await readBody(res);
  if (!res.ok) throw new DirectTransportError(res.status, data);
  return { status: res.status, data };
}
