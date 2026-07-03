/**
 * Telnyx number-porting API (bring your own number).
 *
 * Thin, typed wrappers around the Porting v2 REST endpoints, in the same
 * style as `src/lib/telnyx/numbers.ts` — this file stays strictly
 * Telnyx-contract-shaped; the BYON orchestration (persisting
 * number_port_requests rows, webhooks, wiring the DID after the port
 * completes) lives in higher-level modules.
 *
 * The port-in lifecycle these methods drive:
 *
 *   1. `checkPortability`     — instant yes/no + FastPort eligibility
 *   2. `createPortingOrder`   — draft order (Telnyx may split into several)
 *   3. `uploadDocument` x2    — LOA + recent invoice PDFs → document ids
 *   4. `updatePortingOrder`   — attach documents, end-user/account details,
 *                               requested FOC date, per-order webhook_url
 *   5. `confirmPortingOrder`  — submit to the losing carrier
 *   6. `porting_order.status_changed` webhooks report progress; exception
 *      details carry actionable codes (ACCOUNT_NUMBER_MISMATCH, …)
 *
 * Docs:
 *  - Portability check: https://developers.telnyx.com/api-reference/phone-number-porting/run-a-portability-check
 *  - Porting orders:    https://developers.telnyx.com/api-reference/porting-orders/create-a-porting-order
 *  - Documents:         https://developers.telnyx.com/api-reference/documents/upload-a-document
 */

import { TelnyxApiError, DEFAULT_TELNYX_API_BASE_URL } from "@/lib/telnyx/numbers";

type FetchLike = typeof fetch;

export type TelnyxPortingClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Per-request timeout in ms. Default: 30s (document uploads can be slow). */
  timeoutMs?: number;
  /** Optional User-Agent tag used on every outgoing request. */
  userAgent?: string;
};

export type PortabilityCheckResult = {
  phone_number: string;
  portable: boolean;
  /** FastPort-eligible numbers complete in 1–4 business days. */
  fast_portable: boolean;
  /** Empty/null when the number is portable. */
  not_portable_reason?: string | null;
  carrier_name?: string;
  phone_number_type?: string;
  messaging_capable?: boolean;
};

/** Actionable exception detail (e.g. ACCOUNT_NUMBER_MISMATCH). */
export type PortingExceptionDetail = {
  code?: string;
  description?: string;
};

export type PortingOrderStatusValue =
  | "draft"
  | "in-process"
  | "submitted"
  | "exception"
  | "foc-date-confirmed"
  | "ported"
  | "cancelled"
  | "cancel-pending"
  | (string & {});

export type PortingOrder = {
  id: string;
  status?: { value?: PortingOrderStatusValue; details?: PortingExceptionDetail[] };
  /** Reference this when contacting Telnyx support about the order. */
  support_key?: string | null;
  customer_reference?: string | null;
  phone_number_type?: string;
  phone_numbers?: Array<{
    phone_number?: string;
    porting_order_status?: string;
    portability_status?: string;
    activation_status?: string;
  }>;
  activation_settings?: {
    fast_port_eligible?: boolean;
    foc_datetime_requested?: string | null;
    foc_datetime_actual?: string | null;
    activation_status?: string | null;
  };
  documents?: { loa?: string | null; invoice?: string | null };
  requirements_met?: boolean;
  webhook_url?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type UpdatePortingOrderPatch = {
  /** Document ids returned by {@link TelnyxPortingClient.uploadDocument}. */
  documents?: { loa?: string; invoice?: string };
  endUser?: {
    admin?: {
      /** Name of the business on the losing carrier's account. */
      entity_name?: string;
      /** Person authorized to make the port (matches the LOA signature). */
      auth_person_name?: string;
      billing_phone_number?: string;
      account_number?: string;
      tax_identifier?: string;
      pin_passcode?: string;
      business_identifier?: string;
    };
    location?: {
      street_address?: string;
      extended_address?: string;
      locality?: string;
      administrative_area?: string;
      postal_code?: string;
      country_code?: string;
    };
  };
  /** 'full' unless only part of the losing account's numbers move. */
  misc?: {
    type?: "full" | "partial";
    remaining_numbers_action?: "keep" | "disconnect" | null;
    new_billing_phone_number?: string | null;
  };
  /** ISO datetime for the requested FOC (activation) date. */
  focDatetimeRequested?: string;
  /** Associate the ported numbers with platform wiring on activation. */
  phoneNumberConfiguration?: {
    connection_id?: string;
    messaging_profile_id?: string;
    emergency_address_id?: string;
    tags?: string[];
  };
  /** Per-order status webhook (porting_order.status_changed deliveries). */
  webhookUrl?: string;
  userReference?: string;
};

export type UploadedDocument = {
  id: string;
  filename?: string;
  content_type?: string;
  status?: string;
};

export type AllowedFocWindow = {
  started_at?: string;
  ended_at?: string;
};

export class TelnyxPortingClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly userAgent?: string;

  constructor(options: TelnyxPortingClientOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new Error("TelnyxPortingClient: apiKey is required");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_TELNYX_API_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.userAgent = options.userAgent;
  }

  /** Instant portability + FastPort check for one or more E.164 numbers. */
  async checkPortability(phoneNumbers: string[]): Promise<PortabilityCheckResult[]> {
    if (!phoneNumbers || phoneNumbers.length === 0) {
      throw new Error("TelnyxPortingClient.checkPortability: phoneNumbers is required");
    }
    const json = await this.request<{ data: PortabilityCheckResult[] }>(
      "POST",
      "/portability_checks",
      { phone_numbers: phoneNumbers }
    );
    return json.data ?? [];
  }

  /**
   * Create a draft porting order. Telnyx may split the numbers into multiple
   * orders (by country / number type / SPID / FastPort eligibility), so the
   * response is always an array — each order must be updated and confirmed
   * independently.
   */
  async createPortingOrder(opts: {
    phoneNumbers: string[];
    customerReference?: string;
  }): Promise<PortingOrder[]> {
    if (!opts.phoneNumbers || opts.phoneNumbers.length === 0) {
      throw new Error("TelnyxPortingClient.createPortingOrder: phoneNumbers is required");
    }
    const body: Record<string, unknown> = { phone_numbers: opts.phoneNumbers };
    if (opts.customerReference) {
      body.customer_reference = opts.customerReference.slice(0, 250);
    }
    const json = await this.request<{ data: PortingOrder[] }>("POST", "/porting_orders", body);
    return json.data ?? [];
  }

  async getPortingOrder(orderId: string): Promise<PortingOrder> {
    if (!orderId || orderId.trim().length === 0) {
      throw new Error("TelnyxPortingClient.getPortingOrder: orderId is required");
    }
    const json = await this.request<{ data: PortingOrder }>(
      "GET",
      `/porting_orders/${encodeURIComponent(orderId)}`
    );
    return json.data;
  }

  /** PATCH documents / end-user details / FOC date / webhook onto a draft order. */
  async updatePortingOrder(orderId: string, patch: UpdatePortingOrderPatch): Promise<PortingOrder> {
    if (!orderId || orderId.trim().length === 0) {
      throw new Error("TelnyxPortingClient.updatePortingOrder: orderId is required");
    }
    const body: Record<string, unknown> = {};
    if (patch.documents) body.documents = patch.documents;
    if (patch.endUser) body.end_user = patch.endUser;
    if (patch.misc) body.misc = patch.misc;
    if (patch.focDatetimeRequested) {
      body.activation_settings = { foc_datetime_requested: patch.focDatetimeRequested };
    }
    if (patch.phoneNumberConfiguration) {
      body.phone_number_configuration = patch.phoneNumberConfiguration;
    }
    if (patch.webhookUrl) body.webhook_url = patch.webhookUrl;
    if (patch.userReference) body.user_reference = patch.userReference.slice(0, 250);

    const json = await this.request<{ data: PortingOrder }>(
      "PATCH",
      `/porting_orders/${encodeURIComponent(orderId)}`,
      body
    );
    return json.data;
  }

  /** Submit the order to the losing carrier (draft → submitted). */
  async confirmPortingOrder(orderId: string): Promise<PortingOrder> {
    if (!orderId || orderId.trim().length === 0) {
      throw new Error("TelnyxPortingClient.confirmPortingOrder: orderId is required");
    }
    const json = await this.request<{ data: PortingOrder }>(
      "POST",
      `/porting_orders/${encodeURIComponent(orderId)}/actions/confirm`
    );
    return json.data;
  }

  /** Cancel a porting order (allowed while not yet ported). */
  async cancelPortingOrder(orderId: string): Promise<PortingOrder> {
    if (!orderId || orderId.trim().length === 0) {
      throw new Error("TelnyxPortingClient.cancelPortingOrder: orderId is required");
    }
    const json = await this.request<{ data: PortingOrder }>(
      "POST",
      `/porting_orders/${encodeURIComponent(orderId)}/actions/cancel`
    );
    return json.data;
  }

  /** FOC (activation) windows the losing carrier will accept for this order. */
  async listAllowedFocWindows(orderId: string): Promise<AllowedFocWindow[]> {
    if (!orderId || orderId.trim().length === 0) {
      throw new Error("TelnyxPortingClient.listAllowedFocWindows: orderId is required");
    }
    const json = await this.request<{ data: AllowedFocWindow[] }>(
      "GET",
      `/porting_orders/${encodeURIComponent(orderId)}/allowed_foc_windows`
    );
    return json.data ?? [];
  }

  /**
   * Upload a PDF (LOA or invoice) to the Documents service; the returned id
   * is what `updatePortingOrder({ documents })` attaches. Telnyx deletes
   * uploads not linked to a service within 30 minutes, so upload right
   * before the order PATCH.
   */
  async uploadDocument(opts: {
    /** Raw file bytes, base64-encoded (no data: prefix). */
    base64: string;
    filename: string;
    customerReference?: string;
  }): Promise<UploadedDocument> {
    if (!opts.base64 || opts.base64.trim().length === 0) {
      throw new Error("TelnyxPortingClient.uploadDocument: base64 is required");
    }
    if (!opts.filename || opts.filename.trim().length === 0) {
      throw new Error("TelnyxPortingClient.uploadDocument: filename is required");
    }
    const body: Record<string, unknown> = {
      file: opts.base64,
      filename: opts.filename
    };
    if (opts.customerReference) {
      body.customer_reference = opts.customerReference.slice(0, 250);
    }
    const json = await this.request<{ data: UploadedDocument }>("POST", "/documents", body);
    return json.data;
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown
  ): Promise<T> {
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
