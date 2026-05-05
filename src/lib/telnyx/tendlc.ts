/**
 * Telnyx 10DLC (A2P SMS) API client.
 *
 * Background — why this file exists:
 *   US carriers (Verizon/AT&T/T-Mobile) silently drop A2P SMS from numbers
 *   that aren't attached to an approved 10DLC campaign — message-detail
 *   records show `delivery_failed` on the campaign side but the Telnyx
 *   POST /messages call returns 200, so without DLR observability or this
 *   wrapper we have no idea why customers don't see replies. The brand is
 *   already registered (id `4b20019d-…` / TCR `BZKJLIU`); this client lets
 *   us:
 *     - submit ONE shared campaign on top of that brand (one-shot, idempotent
 *       at the brand-id level since Telnyx 409s a duplicate),
 *     - register each new customer DID against the shared campaign during
 *       provisioning, and
 *     - re-poll campaign status so the dashboard banner can flip from
 *       "pending" to "registered" as soon as carriers approve.
 *
 * Scope: this is intentionally a thin REST wrapper. All persistence and
 * orchestration logic lives in `provisioning/tendlc-attach.ts`. Tests stub
 * the `fetchImpl` so we never hit Telnyx in CI.
 *
 * Telnyx API endpoints used:
 *   POST   /v2/10dlc/campaignBuilder              — submit a campaign for vetting
 *   GET    /v2/10dlc/campaign/{campaignId}        — fetch campaign + status
 *   POST   /v2/10dlc/phoneNumberCampaign          — attach a DID to a campaign
 *   GET    /v2/10dlc/phoneNumberCampaign/{e164}   — read-back the attachment
 *   DELETE /v2/10dlc/phoneNumberCampaign/{e164}   — detach (rotation)
 */

const DEFAULT_BASE_URL = "https://api.telnyx.com/v2";

export type FetchLike = typeof fetch;

export type TendlcClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Per-request timeout. Defaults to 30s (campaign vetting submit can be slow). */
  timeoutMs?: number;
  userAgent?: string;
};

export type TendlcCampaignSubmit = {
  brandId: string;
  /**
   * Use case (eg "CUSTOMER_CARE", "MIXED"). Drives carrier fees + vetting
   * stringency. Must be a value the brand qualifies for; check via
   * `/10dlc/campaignBuilder/qualify` before submit if unsure.
   */
  usecase: string;
  /** 2-4 sentence plain-English description of what the campaign sends. */
  description: string;
  /** How users opt in to receive messages. */
  messageFlow: string;
  /** Response to HELP. */
  helpMessage: string;
  /** Response to STOP (required when subscriberOptout=true). */
  optoutMessage: string;
  /** Response to START / opt-in (required when subscriberOptin=true). */
  optinMessage: string;
  /** Comma-separated keywords. */
  optinKeywords: string;
  optoutKeywords: string;
  helpKeywords: string;
  /** Sample messages — most usecases require ≥2; we always send 5 to be safe. */
  sample1: string;
  sample2: string;
  sample3?: string;
  sample4?: string;
  sample5?: string;
  subscriberOptin?: boolean;
  subscriberOptout?: boolean;
  subscriberHelp?: boolean;
  embeddedLink?: boolean;
  embeddedPhone?: boolean;
  numberPool?: boolean;
  ageGated?: boolean;
  directLending?: boolean;
  affiliateMarketing?: boolean;
};

export type TendlcCampaign = {
  campaignId: string;
  /**
   * Vetting state — surfaced verbatim from Telnyx because the set of values
   * has historically expanded ("ACTIVE", "PENDING", "FAILED", "EXPIRED",
   * "SUSPENDED", "REJECTED", "DELETED", …). Callers should treat
   * "ACTIVE" as the only state where attaches will succeed.
   */
  status: string;
  brandId?: string;
  usecase?: string;
  resellerId?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type TendlcPhoneNumberCampaign = {
  phoneNumber: string;
  campaignId: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
};

export class TendlcApiError extends Error {
  public readonly status: number;
  public readonly endpoint: string;
  public readonly body: string;
  /** True when Telnyx returns 409 (already exists / duplicate) — caller may
   * treat as success. */
  public readonly conflict: boolean;
  constructor(endpoint: string, status: number, body: string) {
    super(`Telnyx 10DLC ${endpoint} failed (${status}): ${body.slice(0, 400)}`);
    this.name = "TendlcApiError";
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
    this.conflict = status === 409;
  }
}

export class TendlcClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly userAgent?: string;

  constructor(opts: TendlcClientOptions) {
    if (!opts.apiKey || opts.apiKey.trim().length === 0) {
      throw new Error("TendlcClient: apiKey is required");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.userAgent = opts.userAgent;
  }

  /**
   * Submit a campaign for carrier vetting. Telnyx charges a non-refundable
   * 3-month upfront fee at this point, so callers should usually idempotency-
   * gate on `business_configs.telnyx_10dlc_campaign_id` (or env) and skip
   * this call when one already exists.
   */
  async createCampaign(input: TendlcCampaignSubmit): Promise<TendlcCampaign> {
    const json = await this.request<{ data?: unknown } & Record<string, unknown>>(
      "POST",
      "/10dlc/campaignBuilder",
      input
    );
    return normalizeCampaign(json);
  }

  /** Fetch a campaign's current status (poll while it's being vetted). */
  async getCampaign(campaignId: string): Promise<TendlcCampaign> {
    if (!campaignId || campaignId.trim().length === 0) {
      throw new Error("TendlcClient.getCampaign: campaignId is required");
    }
    const json = await this.request<Record<string, unknown>>(
      "GET",
      `/10dlc/campaign/${encodeURIComponent(campaignId)}`
    );
    return normalizeCampaign(json);
  }

  /**
   * Attach a DID to a campaign. The DID must already be on a messaging
   * profile and the campaign must be `ACTIVE`. Telnyx returns 409 if the
   * pairing already exists — the wrapper still throws but the caller can
   * inspect `err.conflict` to treat as success (idempotency).
   */
  async createPhoneNumberCampaign(opts: {
    phoneNumber: string;
    campaignId: string;
  }): Promise<TendlcPhoneNumberCampaign> {
    const json = await this.request<Record<string, unknown>>(
      "POST",
      "/10dlc/phoneNumberCampaign",
      { phoneNumber: opts.phoneNumber, campaignId: opts.campaignId }
    );
    return normalizePhoneNumberCampaign(json);
  }

  /** Read-back the current campaign attachment for a DID. 404 → null. */
  async getPhoneNumberCampaign(
    phoneNumber: string
  ): Promise<TendlcPhoneNumberCampaign | null> {
    try {
      const json = await this.request<Record<string, unknown>>(
        "GET",
        `/10dlc/phoneNumberCampaign/${encodeURIComponent(phoneNumber)}`
      );
      return normalizePhoneNumberCampaign(json);
    } catch (err) {
      if (err instanceof TendlcApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Detach a DID from its current campaign (e.g. before rotation). */
  async deletePhoneNumberCampaign(phoneNumber: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/10dlc/phoneNumberCampaign/${encodeURIComponent(phoneNumber)}`
    );
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const ac = new AbortController();
    /* c8 ignore next -- abort callback fires only on real network timeout */
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json"
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (this.userAgent) headers["User-Agent"] = this.userAgent;

      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new TendlcApiError(path, res.status, text);
      }
      // DELETE returns 204 with no body.
      if (res.status === 204) return undefined as unknown as T;
      const text = await res.text();
      if (!text) return undefined as unknown as T;
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeCampaign(raw: Record<string, unknown>): TendlcCampaign {
  // Telnyx's 10DLC endpoints sometimes wrap responses in `{ data: { … } }`
  // (campaign builder submit), sometimes return the campaign at the top
  // level (GET /campaign/{id}). Normalize both shapes here so callers don't
  // have to.
  const data =
    raw && typeof raw === "object" && raw.data && typeof raw.data === "object"
      ? (raw.data as Record<string, unknown>)
      : raw;
  const campaignId =
    typeof data.campaignId === "string"
      ? data.campaignId
      : typeof data.id === "string"
        ? data.id
        : "";
  if (!campaignId) {
    throw new Error("Telnyx 10DLC: campaign response missing campaignId");
  }
  return {
    campaignId,
    status: typeof data.status === "string" ? data.status : "",
    brandId: typeof data.brandId === "string" ? data.brandId : undefined,
    usecase: typeof data.usecase === "string" ? data.usecase : undefined,
    resellerId:
      typeof data.resellerId === "string"
        ? data.resellerId
        : data.resellerId === null
          ? null
          : undefined,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : undefined,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : undefined
  };
}

function normalizePhoneNumberCampaign(
  raw: Record<string, unknown>
): TendlcPhoneNumberCampaign {
  const data =
    raw && typeof raw === "object" && raw.data && typeof raw.data === "object"
      ? (raw.data as Record<string, unknown>)
      : raw;
  const phoneNumber =
    typeof data.phoneNumber === "string"
      ? data.phoneNumber
      : typeof data.phone_number === "string"
        ? data.phone_number
        : "";
  const campaignId =
    typeof data.campaignId === "string"
      ? data.campaignId
      : typeof data.campaign_id === "string"
        ? data.campaign_id
        : "";
  if (!phoneNumber || !campaignId) {
    throw new Error(
      "Telnyx 10DLC: phoneNumberCampaign response missing phoneNumber/campaignId"
    );
  }
  return {
    phoneNumber,
    campaignId,
    status: typeof data.status === "string" ? data.status : undefined,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : undefined,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : undefined
  };
}
