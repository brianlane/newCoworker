/**
 * Typed client for the real Hostinger Developer API.
 *
 * Docs: https://developers.hostinger.com/
 * SDKs consulted to pin endpoint shapes: `hostinger/api-php-sdk`,
 *                                       `hostinger/api-python-sdk`.
 *
 * Everything here is *primitive* — a thin, composable wrapper around the REST
 * endpoints. Orchestration (keypair generation, post-install script content,
 * retry + polling, SSH exec) lives in sibling modules so this file stays
 * strictly Hostinger-contract-shaped and easy to mock in tests.
 *
 * Hostinger does NOT expose a `POST /exec` endpoint — any command execution
 * happens via SSH against the public IP with a private key we minted
 * ourselves. See `./ssh.ts`.
 */

type FetchLike = typeof fetch;

export const DEFAULT_HOSTINGER_BASE_URL = "https://developers.hostinger.com";

export type HostingerClientOptions = {
  baseUrl?: string;
  token: string;
  fetchImpl?: FetchLike;
  /** Per-request timeout in ms. Default: 30s. Hostinger's provisioning endpoints routinely need 10–20s; tighter timeouts cause spurious failures. */
  timeoutMs?: number;
  /** Optional User-Agent tag used on every outgoing request. */
  userAgent?: string;
};

export type CatalogPrice = {
  id: string;
  name: string;
  currency: string;
  /** Amount in the smallest currency subunit (cents for USD). */
  price: number;
  first_period_price?: number;
  period: number;
  period_unit: "month" | "year" | string;
};

export type CatalogItem = {
  id: string;
  name: string;
  category: string;
  prices: CatalogPrice[];
};

export type PaymentMethod = {
  id: number;
  name: string;
  identifier: string;
  payment_method: string;
  is_default: boolean;
  is_expired: boolean;
  is_suspended: boolean;
};

export type DataCenter = {
  id: number;
  name: string;
  location: string;
  city: string;
  continent: string;
};

export type VpsTemplate = {
  id: number;
  name: string;
  description?: string;
};

export type PublicKey = {
  id: number;
  name: string;
  key: string;
};

export type PostInstallScript = {
  id: number;
  name: string;
  content: string;
  created_at?: string;
  updated_at?: string;
};

export type VpsSetupRequest = {
  data_center_id: number;
  template_id: number;
  password?: string;
  hostname?: string;
  /** Array of public-key resource IDs previously returned by {@link HostingerClient.createPublicKey}. */
  public_key_ids?: number[];
  post_install_script_id?: number;
  install_monarx?: boolean;
  enable_backups?: boolean;
  ns1?: string;
  ns2?: string;
};

export type VpsPurchaseRequest = {
  /** Price item id from {@link HostingerClient.listCatalog} (e.g. `hostingercom-vps-kvm2-usd-1m`). */
  item_id: string;
  /** Optional — Hostinger uses the account default when omitted. */
  payment_method_id?: number;
  setup: VpsSetupRequest;
  coupons?: string[];
};

export type VirtualMachineState =
  | "initial"
  | "installing"
  | "running"
  | "stopped"
  | "suspended"
  | "error"
  | string;

export type VirtualMachine = {
  id: number;
  firewall_group_id?: number | null;
  subscription_id?: string;
  plan?: string;
  hostname?: string;
  state: VirtualMachineState;
  actions_lock?: "locked" | "unlocked" | string;
  cpus?: number;
  memory?: number;
  disk?: number;
  bandwidth?: number;
  ns1?: string;
  ns2?: string;
  ipv4?: Array<{ id: number; address: string; ptr?: string }>;
  ipv6?: Array<{ id: number; address: string; ptr?: string }>;
  template?: VpsTemplate;
  data_center?: DataCenter;
  created_at?: string;
};

export type VirtualMachineOrder = {
  order_id: string;
  /** Hostinger returns an array because a single order can create multiple VPSes when quantity > 1. We always purchase one at a time, but we expose the full array for flexibility. */
  virtual_machines: VirtualMachine[];
};

export type Action = {
  id: number;
  name: string;
  state: "initiated" | "running" | "success" | "error" | string;
  progress?: number;
  error?: string | null;
  created_at?: string;
  finished_at?: string | null;
};

export type MonarxMetrics = {
  last_scan_at?: string | null;
  total_files?: number;
  threats?: number;
};

export type DockerProjectCreateRequest = {
  project_name?: string;
  /** `content` is the docker-compose.yml body OR a `https://github.com/user/repo` URL. */
  content: string;
  environment?: Record<string, string>;
};

export type DockerProjectResource = {
  name: string;
  url?: string;
  status?: string;
  created_at?: string;
};

export type Paginated<T> = {
  data: T[];
  meta?: {
    current_page?: number;
    last_page?: number;
    total?: number;
  };
};

export class HostingerApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly endpoint: string;

  constructor(endpoint: string, status: number, body: unknown, message?: string) {
    /* c8 ignore next -- default message is a fallback; all call sites currently pass a message */
    super(message ?? `Hostinger API ${endpoint} → HTTP ${status}`);
    this.name = "HostingerApiError";
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
  }
}

export class HostingerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: HostingerClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_HOSTINGER_BASE_URL).replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.userAgent = options.userAgent ?? "newcoworker-orchestrator/1.0";
  }

  // -------------------- Billing --------------------

  async listCatalog(category?: string): Promise<CatalogItem[]> {
    const qs = category ? `?category=${encodeURIComponent(category)}` : "";
    const res = await this.request<CatalogItem[]>("GET", `/api/billing/v1/catalog${qs}`);
    // Catalog is returned as a bare array, not a paginated envelope.
    /* c8 ignore next -- defensive against Hostinger returning a non-array */
    return Array.isArray(res) ? res : [];
  }

  async listPaymentMethods(): Promise<PaymentMethod[]> {
    const res = await this.request<PaymentMethod[]>("GET", "/api/billing/v1/payment-methods");
    /* c8 ignore next -- defensive against Hostinger returning a non-array */
    return Array.isArray(res) ? res : [];
  }

  // -------------------- VPS metadata --------------------

  async listDataCenters(): Promise<DataCenter[]> {
    const res = await this.request<DataCenter[]>("GET", "/api/vps/v1/data-centers");
    /* c8 ignore next -- defensive against Hostinger returning a non-array */
    return Array.isArray(res) ? res : [];
  }

  async listTemplates(): Promise<VpsTemplate[]> {
    const res = await this.request<VpsTemplate[]>("GET", "/api/vps/v1/templates");
    /* c8 ignore next -- defensive against Hostinger returning a non-array */
    return Array.isArray(res) ? res : [];
  }

  // -------------------- Public keys --------------------

  async listPublicKeys(page = 1): Promise<PublicKey[]> {
    const res = await this.request<PublicKey[] | Paginated<PublicKey>>(
      "GET",
      `/api/vps/v1/public-keys?page=${page}`
    );
    return normalizeList<PublicKey>(res);
  }

  async createPublicKey(name: string, key: string): Promise<PublicKey> {
    return this.request<PublicKey>("POST", "/api/vps/v1/public-keys", { name, key });
  }

  async deletePublicKey(publicKeyId: number): Promise<void> {
    await this.request<unknown>("DELETE", `/api/vps/v1/public-keys/${publicKeyId}`);
  }

  /**
   * Attach one or more already-uploaded public keys to a running VPS.
   * Hostinger also accepts `public_key_ids` via the setup payload at purchase
   * time — use this method only when retro-adding keys to an existing VPS.
   */
  async attachPublicKey(virtualMachineId: number, ids: number[]): Promise<Action> {
    return this.request<Action>(
      "POST",
      `/api/vps/v1/public-keys/attach/${virtualMachineId}`,
      { ids }
    );
  }

  // -------------------- Post-install scripts --------------------

  async listPostInstallScripts(page = 1): Promise<PostInstallScript[]> {
    const res = await this.request<PostInstallScript[] | Paginated<PostInstallScript>>(
      "GET",
      `/api/vps/v1/post-install-scripts?page=${page}`
    );
    return normalizeList<PostInstallScript>(res);
  }

  async createPostInstallScript(name: string, content: string): Promise<PostInstallScript> {
    if (byteLength(content) > 48 * 1024) {
      throw new Error(
        `Post-install script '${name}' exceeds Hostinger's 48KB limit (${byteLength(content)} bytes)`
      );
    }
    return this.request<PostInstallScript>("POST", "/api/vps/v1/post-install-scripts", {
      name,
      content
    });
  }

  async updatePostInstallScript(
    postInstallScriptId: number,
    name: string,
    content: string
  ): Promise<PostInstallScript> {
    if (byteLength(content) > 48 * 1024) {
      throw new Error(
        `Post-install script '${name}' exceeds Hostinger's 48KB limit (${byteLength(content)} bytes)`
      );
    }
    return this.request<PostInstallScript>(
      "PUT",
      `/api/vps/v1/post-install-scripts/${postInstallScriptId}`,
      { name, content }
    );
  }

  async deletePostInstallScript(postInstallScriptId: number): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/vps/v1/post-install-scripts/${postInstallScriptId}`
    );
  }

  // -------------------- Virtual machines --------------------

  async listVirtualMachines(): Promise<VirtualMachine[]> {
    const res = await this.request<VirtualMachine[]>("GET", "/api/vps/v1/virtual-machines");
    /* c8 ignore next -- defensive against Hostinger returning a non-array */
    return Array.isArray(res) ? res : [];
  }

  async getVirtualMachine(virtualMachineId: number): Promise<VirtualMachine> {
    return this.request<VirtualMachine>(
      "GET",
      `/api/vps/v1/virtual-machines/${virtualMachineId}`
    );
  }

  /**
   * ⚠️ This *purchases* a new VPS subscription and starts setup. Only invoke
   * after explicit operator / orchestrator intent. The Hostinger default
   * payment method is charged unless {@link VpsPurchaseRequest.payment_method_id} is set.
   */
  async purchaseVirtualMachine(req: VpsPurchaseRequest): Promise<VirtualMachineOrder> {
    return this.request<VirtualMachineOrder>("POST", "/api/vps/v1/virtual-machines", req);
  }

  async setupVirtualMachine(
    virtualMachineId: number,
    setup: VpsSetupRequest
  ): Promise<Action> {
    return this.request<Action>(
      "POST",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/setup`,
      setup
    );
  }

  async recreateVirtualMachine(
    virtualMachineId: number,
    setup: VpsSetupRequest
  ): Promise<Action> {
    return this.request<Action>(
      "POST",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/recreate`,
      setup
    );
  }

  async restartVirtualMachine(virtualMachineId: number): Promise<Action> {
    return this.request<Action>(
      "POST",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/restart`
    );
  }

  async stopVirtualMachine(virtualMachineId: number): Promise<Action> {
    return this.request<Action>(
      "POST",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/stop`
    );
  }

  async startVirtualMachine(virtualMachineId: number): Promise<Action> {
    return this.request<Action>(
      "POST",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/start`
    );
  }

  // -------------------- Actions --------------------

  async listActions(virtualMachineId: number, page = 1): Promise<Action[]> {
    const res = await this.request<Action[] | Paginated<Action>>(
      "GET",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/actions?page=${page}`
    );
    return normalizeList<Action>(res);
  }

  async getAction(virtualMachineId: number, actionId: number): Promise<Action> {
    return this.request<Action>(
      "GET",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/actions/${actionId}`
    );
  }

  // -------------------- Malware scanner (Monarx) --------------------

  async installMonarx(virtualMachineId: number): Promise<Action> {
    return this.request<Action>(
      "POST",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/monarx`
    );
  }

  async uninstallMonarx(virtualMachineId: number): Promise<Action> {
    return this.request<Action>(
      "DELETE",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/monarx`
    );
  }

  async getMonarxMetrics(virtualMachineId: number): Promise<MonarxMetrics> {
    return this.request<MonarxMetrics>(
      "GET",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/monarx`
    );
  }

  // -------------------- Docker Manager --------------------

  async listDockerProjects(virtualMachineId: number): Promise<DockerProjectResource[]> {
    const res = await this.request<DockerProjectResource[]>(
      "GET",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/docker`
    );
    /* c8 ignore next -- defensive against Hostinger returning a non-array */
    return Array.isArray(res) ? res : [];
  }

  async createDockerProject(
    virtualMachineId: number,
    req: DockerProjectCreateRequest
  ): Promise<Action> {
    return this.request<Action>(
      "POST",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/docker`,
      req
    );
  }

  async deleteDockerProject(virtualMachineId: number, projectName: string): Promise<Action> {
    return this.request<Action>(
      "DELETE",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/docker/${encodeURIComponent(
        projectName
      )}/down`
    );
  }

  async restartDockerProject(virtualMachineId: number, projectName: string): Promise<Action> {
    return this.request<Action>(
      "POST",
      `/api/vps/v1/virtual-machines/${virtualMachineId}/docker/${encodeURIComponent(
        projectName
      )}/restart`
    );
  }

  // -------------------- Request plumbing --------------------

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "User-Agent": this.userAgent
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    // AbortController gives us per-request timeouts without bolting on a
    // dependency. Hostinger is slow on some endpoints (the catalog routinely
    // takes 10–15s at wall-clock time) so we default generously.
    const ac = new AbortController();
    init.signal = ac.signal;
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      // fetch throws on network errors OR AbortError; distinguish for ops.
      /* c8 ignore next -- `fetch` always rejects with Error; non-Error is defensive */
      const msg = err instanceof Error ? err.message : String(err);
      // DOMException name check avoids importing node:util.types; both node
      // and edge runtimes set .name === "AbortError" on timeout aborts.
      const isAbort =
        typeof err === "object" && err !== null && "name" in err && (err as { name?: string }).name === "AbortError";
      throw new HostingerApiError(
        path,
        0,
        null,
        isAbort ? `Hostinger API ${path} timed out after ${this.timeoutMs}ms` : `Hostinger API ${path} network error: ${msg}`
      );
    } finally {
      clearTimeout(timer);
    }

    // 204 No Content is legal for DELETEs; short-circuit before JSON parse.
    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON error bodies (rare, but Hostinger 502s return plain HTML).
        parsed = { raw: text };
      }
    }

    if (!response.ok) {
      throw new HostingerApiError(path, response.status, parsed, hostingerErrorMessage(parsed, response.status));
    }

    // Hostinger occasionally wraps single-resource responses in `{ data: ... }`.
    // Normalise that here so callers always see the resource directly.
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "data" in (parsed as Record<string, unknown>) &&
      !("meta" in (parsed as Record<string, unknown>))
    ) {
      return (parsed as { data: T }).data;
    }
    return parsed as T;
  }
}

/**
 * Hostinger list endpoints mix two shapes: a bare array (e.g. catalog) and a
 * `{ data: T[], meta: {...} }` envelope (e.g. public keys under pagination).
 * This normaliser returns `T[]` in both cases so callers don't branch.
 */
function normalizeList<T>(res: T[] | Paginated<T>): T[] {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray((res as Paginated<T>).data)) return (res as Paginated<T>).data;
  return [];
}

function byteLength(s: string): number {
  // `Buffer.byteLength` would be Node-only; `TextEncoder` works in both Node
  // and edge runtimes (this file is imported from both).
  return new TextEncoder().encode(s).length;
}

function hostingerErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const m = typeof b.message === "string" ? b.message : null;
    if (m) return `Hostinger API HTTP ${status}: ${m}`;
    if (b.errors && typeof b.errors === "object") {
      // Laravel-style `{ errors: { field: ["…"] } }`
      try {
        return `Hostinger API HTTP ${status}: ${JSON.stringify(b.errors)}`;
      } catch {
        /* fall through */
      }
    }
  }
  return `Hostinger API HTTP ${status}`;
}
