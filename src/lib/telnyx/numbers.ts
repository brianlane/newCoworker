/**
 * Telnyx Numbers API (search + order + associate).
 *
 * Every method is a thin, typed wrapper around the REST endpoint. Higher-level
 * flows (e.g. "find a US number, order it, associate it with our platform
 * Call Control Application + Messaging Profile, and upsert the routing rows")
 * live in `src/lib/telnyx/assign-did.ts` so this file stays strictly
 * Telnyx-contract-shaped and easy to stub in tests.
 *
 * Docs:
 *  - Available numbers:  https://developers.telnyx.com/api/numbers/list-available-phone-numbers
 *  - Number orders:      https://developers.telnyx.com/api/numbers/create-number-order
 *  - Phone numbers:      https://developers.telnyx.com/api/numbers/update-phone-number
 *
 * Purchasing a number costs real money. Callers should gate any `orderNumbers`
 * invocation behind an explicit operator confirmation (admin UI) or an
 * environment feature flag (auto-ordering in orchestrate).
 */

type FetchLike = typeof fetch;

export const DEFAULT_TELNYX_API_BASE_URL = "https://api.telnyx.com/v2";

export type TelnyxNumbersClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Per-request timeout in ms. Default: 30s. */
  timeoutMs?: number;
  /** Optional User-Agent tag used on every outgoing request. */
  userAgent?: string;
};

export type AvailablePhoneNumber = {
  phone_number: string;
  vanity_format?: string;
  cost_information?: {
    monthly_cost?: string;
    upfront_cost?: string;
    currency?: string;
  } | null;
  region_information?: Array<{
    region_type?: string;
    region_name?: string;
  }>;
  features?: Array<{ name: string }>;
  best_effort?: boolean;
  quickship?: boolean;
  reservable?: boolean;
};

export type NumberOrder = {
  id: string;
  status: "pending" | "success" | "failure" | string;
  phone_numbers?: Array<{
    id?: string;
    phone_number: string;
    status?: string;
    regulatory_group_id?: string | null;
  }>;
  messaging_profile_id?: string | null;
  connection_id?: string | null;
  customer_reference?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type PhoneNumberDetails = {
  id: string;
  phone_number: string;
  status?: string;
  connection_id?: string | null;
  messaging_profile_id?: string | null;
  tags?: string[];
};

export type SearchAvailableOptions = {
  countryCode?: string;
  /** NPA (area code), e.g. "212". */
  areaCode?: string;
  /** City, e.g. "New York". */
  locality?: string;
  /** State/province, e.g. "NY". */
  administrativeArea?: string;
  /** Features the number must support. Defaults to ["sms", "voice"]. */
  features?: Array<"sms" | "voice" | "mms" | "fax" | "emergency">;
  /** Max numbers returned. Telnyx caps at 25; our default is 10. */
  limit?: number;
  /** True → only list quickship (ready-to-ship) numbers. */
  quickshipOnly?: boolean;
};

export type OrderNumbersOptions = {
  phoneNumbers: string[];
  /** Associate ordered numbers with this Call Control Application. */
  connectionId?: string;
  /** Associate ordered numbers with this Messaging Profile. */
  messagingProfileId?: string;
  /** Free-form text written back as `customer_reference` (max 250 chars). */
  customerReference?: string;
};

export type UpdatePhoneNumberOptions = {
  /** Either the Telnyx number id (UUID) or the E.164 number (we encode it). */
  phoneNumberIdOrE164: string;
  connectionId?: string | null;
  messagingProfileId?: string | null;
  tags?: string[];
  customerReference?: string;
};

export class TelnyxApiError extends Error {
  public readonly status: number;
  public readonly body: string;
  public readonly endpoint: string;
  constructor(endpoint: string, status: number, body: string) {
    super(`Telnyx ${endpoint} failed (${status}): ${body.slice(0, 300)}`);
    this.name = "TelnyxApiError";
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

export class TelnyxNumbersClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly userAgent?: string;

  constructor(options: TelnyxNumbersClientOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new Error("TelnyxNumbersClient: apiKey is required");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_TELNYX_API_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.userAgent = options.userAgent;
  }

  async searchAvailable(opts: SearchAvailableOptions = {}): Promise<AvailablePhoneNumber[]> {
    const params = new URLSearchParams();
    const country = (opts.countryCode ?? "US").toUpperCase();
    params.set("filter[country_code]", country);
    if (opts.areaCode) params.set("filter[national_destination_code]", opts.areaCode);
    if (opts.locality) params.set("filter[locality]", opts.locality);
    if (opts.administrativeArea) {
      params.set("filter[administrative_area]", opts.administrativeArea.toUpperCase());
    }
    const features = opts.features ?? ["sms", "voice"];
    for (const f of features) params.append("filter[features][]", f);
    params.set("filter[limit]", String(Math.min(Math.max(opts.limit ?? 10, 1), 25)));
    if (opts.quickshipOnly) params.set("filter[quickship]", "true");

    const json = await this.request<{ data: AvailablePhoneNumber[] }>(
      "GET",
      `/available_phone_numbers?${params.toString()}`
    );
    return json.data ?? [];
  }

  async orderNumbers(opts: OrderNumbersOptions): Promise<NumberOrder> {
    if (!opts.phoneNumbers || opts.phoneNumbers.length === 0) {
      throw new Error("TelnyxNumbersClient.orderNumbers: phoneNumbers is required");
    }
    const body: Record<string, unknown> = {
      phone_numbers: opts.phoneNumbers.map((n) => ({ phone_number: n }))
    };
    if (opts.connectionId) body.connection_id = opts.connectionId;
    if (opts.messagingProfileId) body.messaging_profile_id = opts.messagingProfileId;
    if (opts.customerReference) body.customer_reference = opts.customerReference.slice(0, 250);

    const json = await this.request<{ data: NumberOrder }>("POST", "/number_orders", body);
    return json.data;
  }

  async getNumberOrder(orderId: string): Promise<NumberOrder> {
    if (!orderId || orderId.trim().length === 0) {
      throw new Error("TelnyxNumbersClient.getNumberOrder: orderId is required");
    }
    const json = await this.request<{ data: NumberOrder }>(
      "GET",
      `/number_orders/${encodeURIComponent(orderId)}`
    );
    return json.data;
  }

  async updatePhoneNumber(opts: UpdatePhoneNumberOptions): Promise<PhoneNumberDetails> {
    if (!opts.phoneNumberIdOrE164 || opts.phoneNumberIdOrE164.trim().length === 0) {
      throw new Error("TelnyxNumbersClient.updatePhoneNumber: phoneNumberIdOrE164 is required");
    }
    const body: Record<string, unknown> = {};
    if (opts.connectionId !== undefined) body.connection_id = opts.connectionId;
    if (opts.messagingProfileId !== undefined) body.messaging_profile_id = opts.messagingProfileId;
    if (opts.tags !== undefined) body.tags = opts.tags;
    if (opts.customerReference !== undefined) {
      body.customer_reference = opts.customerReference.slice(0, 250);
    }

    const json = await this.request<{ data: PhoneNumberDetails }>(
      "PATCH",
      `/phone_numbers/${encodeURIComponent(opts.phoneNumberIdOrE164)}`,
      body
    );
    return json.data;
  }

  /**
   * Poll `getNumberOrder` until `status === "success"` or timeout.
   * Returns the final order snapshot; does NOT throw on failure — caller
   * should inspect `.status`.
   */
  async waitForNumberOrder(
    orderId: string,
    opts: { timeoutMs?: number; pollIntervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
  ): Promise<NumberOrder> {
    const deadline = (opts.now ?? Date.now)() + (opts.timeoutMs ?? 60_000);
    const step = Math.max(250, opts.pollIntervalMs ?? 2_000);
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let latest = await this.getNumberOrder(orderId);
    while (latest.status === "pending" && (opts.now ?? Date.now)() < deadline) {
      await sleep(step);
      latest = await this.getNumberOrder(orderId);
    }
    return latest;
  }

  private async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const ac = new AbortController();
    /* c8 ignore next -- abort callback fires only on real network timeout; tests don't stall */
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
        throw new TelnyxApiError(path, res.status, text);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
