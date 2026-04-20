// Per-tenant Cloudflare Tunnel provisioning.
//
// Design goals:
//   - Idempotent. Re-running for the same businessId must not create duplicate
//     tunnels or DNS records. Every CF resource is looked up by a deterministic
//     name/hostname and created only when absent.
//   - Offline-safe. If CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not
//     configured, `cloudflareTunnelProvisionerFromEnv` returns null so the
//     orchestrator can fall back to a shared env-var token (legacy behavior).
//   - Deno-free. This runs in the Next.js API / orchestrator, not on Edge.
//   - Testable. All I/O flows through an injected fetch, and the public API
//     returns only primitives (tunnelId/token/hostname) so orchestrate.ts
//     stays easy to mock.
//
// Zone topology assumed: a dedicated CF-managed zone (e.g. tunnel.newcoworker.com)
// that the operator has either transferred to Cloudflare or delegated via NS
// records from the primary DNS host. The apex newcoworker.com does not need
// to live on Cloudflare.

import { logger } from "@/lib/logger";

export type ProvisionedTunnel = {
  tunnelId: string;
  token: string;
  hostname: string;
};

export type CloudflareTunnelProvisioner = (input: {
  businessId: string;
}) => Promise<ProvisionedTunnel>;

export type CloudflareTunnelConfig = {
  apiToken: string;
  accountId: string;
  /**
   * The CF DNS zone that owns the public hostname (e.g. "newcoworker.com" if
   * the entire apex is on CF, or "tunnel.newcoworker.com" if only a delegated
   * subdomain is on CF). Used for the `GET /zones?name=…` lookup.
   */
  zoneName: string;
  /**
   * Suffix appended to `businessId` to form the public hostname. Defaults to
   * `zoneName` (so businessId.zoneName). Set this when the CF zone is at the
   * apex but you want hostnames at a deeper subdomain — e.g. zoneName
   * "newcoworker.com" + hostnameSuffix "tunnel.newcoworker.com" produces
   * "<businessId>.tunnel.newcoworker.com" inside the apex zone.
   */
  hostnameSuffix?: string;
  /** Local service the tunnel forwards to on each VPS. */
  serviceUrl: string;
  /**
   * Pre-known zone id. When supplied we skip the `GET /zones?name=…` lookup,
   * which removes one round-trip and avoids relying on the API token having
   * the zone-list scope (Zone:DNS:Edit is enough on a specific zone).
   */
  zoneId?: string;
  /** Tunnel name prefix, default "nc". Final name is `${prefix}-${businessId}`. */
  tunnelNamePrefix?: string;
  /** Override for tests or non-global fetch implementations. */
  fetchImpl?: typeof fetch;
};

type CfEnvelope<T> = {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  messages?: unknown;
  result: T;
};

function envelopeErrorMessage(body: CfEnvelope<unknown>): string {
  if (!body.errors || body.errors.length === 0) return "unknown error";
  return body.errors.map((e) => `${e.code}: ${e.message}`).join("; ");
}

export function createCloudflareTunnelProvisioner(
  config: CloudflareTunnelConfig
): CloudflareTunnelProvisioner {
  const {
    apiToken,
    accountId,
    zoneName,
    serviceUrl,
    zoneId: configuredZoneId,
    hostnameSuffix = zoneName,
    tunnelNamePrefix = "nc",
    fetchImpl = fetch
  } = config;

  if (!apiToken) throw new Error("CloudflareTunnelConfig.apiToken is required");
  if (!accountId) throw new Error("CloudflareTunnelConfig.accountId is required");
  if (!zoneName) throw new Error("CloudflareTunnelConfig.zoneName is required");
  if (!serviceUrl) throw new Error("CloudflareTunnelConfig.serviceUrl is required");

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      }
    });
    let body: CfEnvelope<T>;
    try {
      body = (await res.json()) as CfEnvelope<T>;
    } catch {
      throw new Error(`Cloudflare API ${path} returned non-JSON (status ${res.status})`);
    }
    if (!body.success) {
      throw new Error(`Cloudflare API ${path} failed: ${envelopeErrorMessage(body)}`);
    }
    return body.result;
  }

  return async function provisionBusinessTunnel({ businessId }): Promise<ProvisionedTunnel> {
    if (!businessId) throw new Error("businessId required");
    const tunnelName = `${tunnelNamePrefix}-${businessId}`;
    const hostname = `${businessId}.${hostnameSuffix}`;

    // 1. Reuse an existing tunnel by name, otherwise create one. CF accepts the
    //    "config_src=cloudflare" mode which lets us manage ingress via API
    //    without distributing a local cloudflared config file.
    const existing = await api<Array<{ id: string; name: string; deleted_at?: string | null }>>(
      `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}`
    );
    const live = Array.isArray(existing) ? existing.filter((t) => !t.deleted_at) : [];
    let tunnelId: string;
    if (live.length > 0) {
      tunnelId = live[0].id;
      logger.info("cloudflare tunnel reused", { businessId, tunnelId, tunnelName });
    } else {
      const created = await api<{ id: string }>(`/accounts/${accountId}/cfd_tunnel`, {
        method: "POST",
        body: JSON.stringify({ name: tunnelName, config_src: "cloudflare" })
      });
      tunnelId = created.id;
      logger.info("cloudflare tunnel created", { businessId, tunnelId, tunnelName });
    }

    // 2. Fetch the install token. CF returns this as a bare string inside
    //    `result`, which is unusual for its API but well documented.
    const token = await api<string>(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
    if (!token || typeof token !== "string") {
      throw new Error(`Cloudflare returned empty tunnel token for ${tunnelId}`);
    }

    // 3. Write the ingress rules. The catch-all 404 entry is required by CF —
    //    ingress arrays must terminate with a rule that has no `hostname`.
    await api(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname, service: serviceUrl },
            { service: "http_status:404" }
          ]
        }
      })
    });

    // 4. Ensure the public hostname CNAME exists in the delegated zone. We
    //    support both "missing" (create) and "stale content" (update) paths so
    //    a re-provision heals drift without operator intervention. If the
    //    caller pre-configured a zoneId we skip the lookup to save a round-trip
    //    (and to avoid needing zone-list scope on the API token).
    let zoneId = configuredZoneId;
    if (!zoneId) {
      const zones = await api<Array<{ id: string; name: string }>>(
        `/zones?name=${encodeURIComponent(zoneName)}`
      );
      if (!zones || zones.length === 0) {
        throw new Error(
          `Cloudflare zone "${zoneName}" not found for account ${accountId}. ` +
            "Delegate the zone to Cloudflare before provisioning per-tenant tunnels."
        );
      }
      zoneId = zones[0].id;
    }
    const cnameTarget = `${tunnelId}.cfargotunnel.com`;

    const records = await api<Array<{ id: string; content: string; proxied: boolean }>>(
      `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`
    );
    if (!records || records.length === 0) {
      await api(`/zones/${zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify({
          type: "CNAME",
          name: hostname,
          content: cnameTarget,
          proxied: true,
          comment: `newCoworker orchestrator: business ${businessId}`
        })
      });
      logger.info("cloudflare DNS CNAME created", { businessId, hostname, cnameTarget });
    } else if (records[0].content !== cnameTarget || records[0].proxied !== true) {
      await api(`/zones/${zoneId}/dns_records/${records[0].id}`, {
        method: "PATCH",
        body: JSON.stringify({
          type: "CNAME",
          name: hostname,
          content: cnameTarget,
          proxied: true
        })
      });
      logger.info("cloudflare DNS CNAME updated", { businessId, hostname, cnameTarget });
    }

    return { tunnelId, token, hostname };
  };
}

export function cloudflareTunnelProvisionerFromEnv(
  env: Record<string, string | undefined> = process.env
): CloudflareTunnelProvisioner | null {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!apiToken || !accountId) return null;
  return createCloudflareTunnelProvisioner({
    apiToken,
    accountId,
    zoneName: env.CLOUDFLARE_TUNNEL_ZONE ?? "tunnel.newcoworker.com",
    serviceUrl: env.CLOUDFLARE_TUNNEL_SERVICE_URL ?? "http://localhost:3000",
    zoneId: env.CLOUDFLARE_ZONE_ID,
    hostnameSuffix: env.CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX
  });
}
