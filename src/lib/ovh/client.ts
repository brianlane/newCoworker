/**
 * Typed client for the OVHcloud APIv6.
 *
 * Default endpoint is `ovh-us` (`api.us.ovhcloud.com`) — the platform's
 * business entity is US, and the OVHcloud US catalog sells the `-ca`
 * suffixed VPS plan codes whose `vps_datacenter` list includes Beauharnois
 * (BHS), so Canadian-residency boxes are purchased through the US account
 * (verified against the live catalog, Jul 2026). Point `OVH_API_BASE_URL`
 * at another control plane (e.g. `https://ca.api.ovh.com/1.0`) only if the
 * account ever moves entities — the signing scheme is identical everywhere.
 *
 * Docs: https://api.us.ovhcloud.com/console/
 * Auth: OVH's application-key scheme — every request carries
 *   X-Ovh-Application (app key), X-Ovh-Consumer (consumer key),
 *   X-Ovh-Timestamp, and X-Ovh-Signature where the signature is
 *   "$1$" + SHA1(AS + "+" + CK + "+" + METHOD + "+" + URL + "+" + BODY + "+" + TS)
 * with AS = application secret. The timestamp must be the SERVER's clock;
 * we fetch `/auth/time` once and cache the delta so a skewed local clock
 * can't invalidate signatures.
 *
 * Like the Hostinger client, everything here is *primitive*: thin, typed
 * wrappers over the REST endpoints the provisioning path needs (order-cart
 * VPS purchase, status/IP polling, rebuild-with-SSH-key, termination).
 * Orchestration lives in sibling modules.
 *
 * Scope note: only what the OVH provisioner consumes is implemented —
 * see the plan (Enterprise BYOS + Canada residency, PR 4/5).
 */

import { createHash } from "node:crypto";

type FetchLike = typeof fetch;

/** OVHcloud US control plane — sells BHS boxes via the `-ca` plan codes. */
export const DEFAULT_OVH_BASE_URL = "https://api.us.ovhcloud.com/1.0";

export type OvhClientOptions = {
  baseUrl?: string;
  applicationKey: string;
  applicationSecret: string;
  consumerKey: string;
  fetchImpl?: FetchLike;
  /** Per-request timeout in ms. Default 30s (order/checkout can be slow). */
  timeoutMs?: number;
  /** Injectable clock (tests). Returns ms since epoch. */
  now?: () => number;
};

export class OvhApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly endpoint: string;

  constructor(endpoint: string, status: number, body: unknown, message?: string) {
    /* c8 ignore next -- default message fallback; call sites pass a message */
    super(message ?? `OVH API ${endpoint} → HTTP ${status}`);
    this.name = "OvhApiError";
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------- order cart

export type OvhOrderCart = {
  cartId: string;
  expire?: string;
  readOnly?: boolean;
};

export type OvhCartItem = {
  itemId: number;
  cartId?: string;
  duration?: string;
  productId?: string;
  settings?: unknown;
};

export type OvhCheckoutOrder = {
  orderId: number;
  url?: string;
  prices?: unknown;
};

// ---------------------------------------------------------------- vps

export type OvhVps = {
  name: string;
  state: "running" | "stopped" | "installing" | "rebooting" | "upgrading" | string;
  displayName?: string | null;
  zone?: string;
  model?: {
    name?: string;
    vcore?: number;
    memory?: number;
    disk?: number;
  };
};

export type OvhVpsImage = {
  id: string;
  name: string;
};

export type OvhVpsTask = {
  id: number;
  type?: string;
  state?: string;
  progress?: number;
};

export type OvhServiceInfos = {
  serviceId: number;
  status?: string;
  renew?: {
    automatic?: boolean;
    deleteAtExpiration?: boolean;
    forced?: boolean;
    period?: string | null;
  };
  expiration?: string;
};

export class OvhClient {
  private readonly baseUrl: string;
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly consumerKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  /** Cached local-clock → OVH-server-clock delta in seconds. */
  private timeDeltaSec: number | null = null;

  constructor(options: OvhClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_OVH_BASE_URL).replace(/\/$/, "");
    this.appKey = options.applicationKey;
    this.appSecret = options.applicationSecret;
    this.consumerKey = options.consumerKey;
    /* c8 ignore next 2 -- trivial production defaults; tests inject both */
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  // -------------------- catalog --------------------

  /**
   * Public VPS catalog for a subsidiary: plan codes, prices, and per-plan
   * configuration value lists (vps_datacenter, vps_os). Unauthenticated
   * endpoint, but we sign anyway — harmless, and keeps the plumbing single-
   * path. Used by the plan-code mapping audit (debug/ovh-catalog.ts).
   */
  async getPublicVpsCatalog(ovhSubsidiary = "US"): Promise<unknown> {
    return this.request("GET", `/order/catalog/public/vps?ovhSubsidiary=${encodeURIComponent(ovhSubsidiary)}`);
  }

  // -------------------- order cart (purchase) --------------------

  async createCart(ovhSubsidiary = "US"): Promise<OvhOrderCart> {
    return this.request("POST", "/order/cart", { ovhSubsidiary });
  }

  /** Bind the cart to the authenticated account (required before checkout). */
  async assignCart(cartId: string): Promise<void> {
    await this.request("POST", `/order/cart/${encodeURIComponent(cartId)}/assign`);
  }

  async addVpsToCart(
    cartId: string,
    input: { planCode: string; duration: string; pricingMode: string; quantity?: number }
  ): Promise<OvhCartItem> {
    return this.request("POST", `/order/cart/${encodeURIComponent(cartId)}/vps`, {
      planCode: input.planCode,
      duration: input.duration,
      pricingMode: input.pricingMode,
      quantity: input.quantity ?? 1
    });
  }

  /** Per-item configuration (e.g. label=vps_datacenter value=bhs, vps_os). */
  async configureCartItem(
    cartId: string,
    itemId: number,
    label: string,
    value: string
  ): Promise<void> {
    await this.request(
      "POST",
      `/order/cart/${encodeURIComponent(cartId)}/item/${itemId}/configuration`,
      { label, value }
    );
  }

  /**
   * Checkout: places the order against the account's default payment method.
   * `waiveRetractationPeriod` is required for immediate delivery in
   * jurisdictions with a legal withdrawal window.
   */
  async checkoutCart(
    cartId: string,
    opts?: { autoPayWithPreferredPaymentMethod?: boolean; waiveRetractationPeriod?: boolean }
  ): Promise<OvhCheckoutOrder> {
    return this.request("POST", `/order/cart/${encodeURIComponent(cartId)}/checkout`, {
      autoPayWithPreferredPaymentMethod: opts?.autoPayWithPreferredPaymentMethod ?? true,
      waiveRetractationPeriod: opts?.waiveRetractationPeriod ?? true
    });
  }

  // -------------------- vps --------------------

  /** All VPS service names on the account. */
  async listVps(): Promise<string[]> {
    const res = await this.request<string[]>("GET", "/vps");
    /* c8 ignore next -- defensive against a non-array response */
    return Array.isArray(res) ? res : [];
  }

  async getVps(serviceName: string): Promise<OvhVps> {
    return this.request("GET", `/vps/${encodeURIComponent(serviceName)}`);
  }

  /** IPs attached to the VPS (v4 + v6, dotted/colon literals). */
  async getVpsIps(serviceName: string): Promise<string[]> {
    const res = await this.request<string[]>(
      "GET",
      `/vps/${encodeURIComponent(serviceName)}/ips`
    );
    /* c8 ignore next -- defensive against a non-array response */
    return Array.isArray(res) ? res : [];
  }

  async getAvailableImages(serviceName: string): Promise<OvhVpsImage[]> {
    // The list endpoint returns bare ids; resolve each to id+name.
    const ids = await this.request<string[]>(
      "GET",
      `/vps/${encodeURIComponent(serviceName)}/images/available`
    );
    /* c8 ignore next -- defensive against a non-array response */
    const list = Array.isArray(ids) ? ids : [];
    const images: OvhVpsImage[] = [];
    for (const id of list) {
      images.push(
        await this.request<OvhVpsImage>(
          "GET",
          `/vps/${encodeURIComponent(serviceName)}/images/available/${encodeURIComponent(id)}`
        )
      );
    }
    return images;
  }

  /**
   * Reinstall the VPS with an image + SSH public key. This is the
   * DETERMINISTIC key-attach path on OVH (mirrors the lesson learned on
   * Hostinger: never depend on a provider's optional key-attach): the
   * rebuild lays the key into root's authorized_keys as part of the OS
   * install, so SSH access never depends on a separate attach call.
   */
  async rebuildVps(
    serviceName: string,
    input: { imageId: string; publicSshKey: string; doNotSendPassword?: boolean }
  ): Promise<OvhVpsTask> {
    return this.request("POST", `/vps/${encodeURIComponent(serviceName)}/rebuild`, {
      imageId: input.imageId,
      publicSshKey: input.publicSshKey,
      doNotSendPassword: input.doNotSendPassword ?? true
    });
  }

  async getVpsTasks(serviceName: string): Promise<number[]> {
    const res = await this.request<number[]>(
      "GET",
      `/vps/${encodeURIComponent(serviceName)}/tasks`
    );
    /* c8 ignore next -- defensive against a non-array response */
    return Array.isArray(res) ? res : [];
  }

  async getVpsTask(serviceName: string, taskId: number): Promise<OvhVpsTask> {
    return this.request(
      "GET",
      `/vps/${encodeURIComponent(serviceName)}/tasks/${taskId}`
    );
  }

  // -------------------- lifecycle / billing --------------------

  async getServiceInfos(serviceName: string): Promise<OvhServiceInfos> {
    return this.request("GET", `/vps/${encodeURIComponent(serviceName)}/serviceInfos`);
  }

  /**
   * Flip the service to delete-at-expiration (the automated "stop paying"
   * lever — OVH's analog of Hostinger's disable-auto-renew).
   */
  async setDeleteAtExpiration(serviceName: string, deleteAtExpiration: boolean): Promise<void> {
    const infos = await this.getServiceInfos(serviceName);
    await this.request("PUT", `/vps/${encodeURIComponent(serviceName)}/serviceInfos`, {
      serviceId: infos.serviceId,
      renew: {
        ...(infos.renew ?? {}),
        // The two flags are one intent here: lapse (delete-at-expiration ON,
        // auto-renew OFF) or keep alive (the inverse). Deriving `automatic`
        // from the stored value would strand a re-enabled service with
        // auto-renew still off after an earlier lapse flip.
        automatic: !deleteAtExpiration,
        deleteAtExpiration
      }
    });
  }

  /**
   * Immediate termination, step 1: OVH emails the account a confirmation
   * token. Complete with {@link confirmTermination}.
   */
  async terminateVps(serviceName: string): Promise<void> {
    await this.request("POST", `/vps/${encodeURIComponent(serviceName)}/terminate`);
  }

  async confirmTermination(
    serviceName: string,
    token: string,
    reason = "OTHER"
  ): Promise<void> {
    await this.request("POST", `/vps/${encodeURIComponent(serviceName)}/confirmTermination`, {
      token,
      reason
    });
  }

  // -------------------- request plumbing --------------------

  /**
   * OVH signatures embed a timestamp that must match the SERVER clock within
   * a small window. Fetch `/auth/time` once and cache the delta.
   */
  private async serverTimeSec(): Promise<number> {
    const localSec = Math.floor(this.now() / 1000);
    if (this.timeDeltaSec === null) {
      const url = `${this.baseUrl}/auth/time`;
      // Same per-request timeout as signed calls — a hung clock endpoint
      // must not hang every client call forever.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: "GET", signal: ac.signal });
      } catch (err) {
        /* c8 ignore next -- fetch always rejects with Error; non-Error is defensive */
        const msg = err instanceof Error ? err.message : String(err);
        const isAbort =
          typeof err === "object" && err !== null && "name" in err && (err as { name?: string }).name === "AbortError";
        throw new OvhApiError(
          "/auth/time",
          0,
          null,
          isAbort
            ? `OVH API /auth/time timed out after ${this.timeoutMs}ms`
            : `OVH API /auth/time network error: ${msg}`
        );
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        throw new OvhApiError("/auth/time", response.status, null, `OVH API /auth/time → HTTP ${response.status}`);
      }
      const serverSec = Number.parseInt((await response.text()).trim(), 10);
      if (!Number.isFinite(serverSec)) {
        throw new OvhApiError("/auth/time", 0, null, "OVH API /auth/time returned a non-numeric clock");
      }
      this.timeDeltaSec = serverSec - localSec;
    }
    return localSec + this.timeDeltaSec;
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const ts = await this.serverTimeSec();

    // "$1$" + SHA1(AS + "+" + CK + "+" + METHOD + "+" + URL + "+" + BODY + "+" + TS)
    const signature =
      "$1$" +
      createHash("sha1")
        .update([this.appSecret, this.consumerKey, method, url, bodyText, String(ts)].join("+"))
        .digest("hex");

    const headers: Record<string, string> = {
      "X-Ovh-Application": this.appKey,
      "X-Ovh-Consumer": this.consumerKey,
      "X-Ovh-Timestamp": String(ts),
      "X-Ovh-Signature": signature,
      Accept: "application/json"
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = bodyText;
    }

    const ac = new AbortController();
    init.signal = ac.signal;
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      /* c8 ignore next -- fetch always rejects with Error; non-Error is defensive */
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort =
        typeof err === "object" && err !== null && "name" in err && (err as { name?: string }).name === "AbortError";
      throw new OvhApiError(
        path,
        0,
        null,
        isAbort ? `OVH API ${path} timed out after ${this.timeoutMs}ms` : `OVH API ${path} network error: ${msg}`
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    if (!response.ok) {
      throw new OvhApiError(path, response.status, parsed, ovhErrorMessage(path, parsed, response.status));
    }
    return parsed as T;
  }
}

function ovhErrorMessage(path: string, body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const m = (body as Record<string, unknown>).message;
    if (typeof m === "string") return `OVH API ${path} HTTP ${status}: ${m}`;
  }
  return `OVH API ${path} HTTP ${status}`;
}

/* c8 ignore start -- env-var construction: callers inject the client in tests.
   Missing env vars surface as a loud throw here rather than cryptic 400s. */
export function ovhClientFromEnv(): OvhClient {
  const applicationKey = process.env.OVH_APP_KEY ?? "";
  const applicationSecret = process.env.OVH_APP_SECRET ?? "";
  const consumerKey = process.env.OVH_CONSUMER_KEY ?? "";
  if (!applicationKey || !applicationSecret || !consumerKey) {
    throw new Error(
      "OVH client requires OVH_APP_KEY, OVH_APP_SECRET, and OVH_CONSUMER_KEY in the environment"
    );
  }
  return new OvhClient({
    baseUrl: process.env.OVH_API_BASE_URL ?? DEFAULT_OVH_BASE_URL,
    applicationKey,
    applicationSecret,
    consumerKey
  });
}
/* c8 ignore stop */
