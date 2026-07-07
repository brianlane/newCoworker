/**
 * Node client for a tenant's box-local residency data API.
 *
 * Speaks the wire contract in src/lib/residency/contract.ts against
 * `data-<businessId>.<zone>` (the tenant's Cloudflare tunnel), authenticated
 * with the tenant's per-box gateway token.
 *
 * Worst-case posture:
 *   * Every call has a hard timeout — a hung box must never wedge a replay
 *     drain or a dashboard request.
 *   * Server-side failures come back HTTP 200 + { ok:false } (the tunnel
 *     replaces origin 5xx bodies); transport failures throw. Callers decide
 *     retry-vs-stop; this client never swallows either.
 */

import {
  DATA_API_PREFIX,
  dataApiHostname,
  type DataApiDeleteRequest,
  type DataApiHealthResponse,
  type DataApiInsertRequest,
  type DataApiResponse,
  type DataApiSelectRequest,
  type DataApiUpdateRequest
} from "@/lib/residency/contract";
import { getActiveGatewayTokenForBusiness } from "@/lib/db/vps-gateway-tokens";

const DEFAULT_TIMEOUT_MS = 10_000;

export type DataApiClientOptions = {
  /** Override base URL (tests / port-forwarded smoke). Default: tunnel hostname. */
  baseUrl?: string;
  /** Bearer token. Default: the business's active gateway token from the DB. */
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class DataApiTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataApiTransportError";
  }
}

/**
 * Resolve the tenant's data-API base URL. Mirrors the voice/render hostname
 * conventions: `https://data-<businessId>.<suffix>` where the suffix is
 * CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX (blank-coerced) falling back to
 * CLOUDFLARE_TUNNEL_ZONE, falling back to newcoworker.com.
 */
export function residencyDataBaseUrl(
  businessId: string,
  env: Record<string, string | undefined> = process.env
): string {
  const blank = (v: string | undefined): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t.length === 0 ? undefined : t;
  };
  const suffix =
    blank(env.CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX) ??
    blank(env.CLOUDFLARE_TUNNEL_ZONE) ??
    "newcoworker.com";
  return `https://${dataApiHostname(businessId, suffix)}`;
}

export class DataApiClient {
  private readonly businessId: string;
  private readonly baseUrl?: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private resolvedToken?: string;

  constructor(businessId: string, options: DataApiClientOptions = {}) {
    this.businessId = businessId;
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    /* v8 ignore next -- bare global fetch is the production default; tests always inject fetchImpl */
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async bearer(): Promise<string> {
    if (this.token) return this.token;
    if (this.resolvedToken) return this.resolvedToken;
    const token = await getActiveGatewayTokenForBusiness(this.businessId);
    if (!token) {
      throw new DataApiTransportError(
        `no active gateway token for business ${this.businessId}`
      );
    }
    this.resolvedToken = token;
    return token;
  }

  private async post<Row>(
    path: "select" | "insert" | "update" | "delete",
    body:
      | DataApiSelectRequest
      | DataApiInsertRequest
      | DataApiUpdateRequest
      | DataApiDeleteRequest
  ): Promise<DataApiResponse<Row>> {
    const base = this.baseUrl ?? residencyDataBaseUrl(this.businessId);
    const bearer = await this.bearer();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}${DATA_API_PREFIX}/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      throw new DataApiTransportError(
        `data-api ${path} for ${this.businessId} unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // 4xx pass through the tunnel; 5xx bodies are Cloudflare's. Either way
      // a non-2xx is a transport-class failure for callers.
      throw new DataApiTransportError(
        `data-api ${path} for ${this.businessId} returned HTTP ${res.status}`
      );
    }
    return (await res.json()) as DataApiResponse<Row>;
  }

  select<Row = Record<string, unknown>>(
    req: DataApiSelectRequest
  ): Promise<DataApiResponse<Row>> {
    return this.post<Row>("select", req);
  }

  insert<Row = Record<string, unknown>>(
    req: DataApiInsertRequest
  ): Promise<DataApiResponse<Row>> {
    return this.post<Row>("insert", req);
  }

  update<Row = Record<string, unknown>>(
    req: DataApiUpdateRequest
  ): Promise<DataApiResponse<Row>> {
    return this.post<Row>("update", req);
  }

  delete<Row = Record<string, unknown>>(
    req: DataApiDeleteRequest
  ): Promise<DataApiResponse<Row>> {
    return this.post<Row>("delete", req);
  }

  /** GET /v1/health — unauthenticated; ok:false means datastore unreachable. */
  async health(): Promise<DataApiHealthResponse> {
    const base = this.baseUrl ?? residencyDataBaseUrl(this.businessId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${base}${DATA_API_PREFIX}/health`, {
        signal: controller.signal
      });
      if (!res.ok) {
        throw new DataApiTransportError(
          `data-api health for ${this.businessId} returned HTTP ${res.status}`
        );
      }
      return (await res.json()) as DataApiHealthResponse;
    } catch (err) {
      if (err instanceof DataApiTransportError) throw err;
      throw new DataApiTransportError(
        `data-api health for ${this.businessId} unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
