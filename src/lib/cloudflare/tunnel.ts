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
  /** Public hostname forwarding to `serviceUrl` (e.g. Rowboat on :3000). */
  hostname: string;
  /** Public hostname forwarding to `voiceServiceUrl` (voice bridge on :8090). */
  voiceHostname: string;
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
  /** Local service the tunnel forwards to on each VPS (Rowboat, default :3000). */
  serviceUrl: string;
  /**
   * Local voice-bridge service URL (default "http://127.0.0.1:8090"). The
   * tunnel publishes this behind a separate public hostname so Telnyx can
   * reach the media WebSocket with a CF-issued cert — no per-VPS Caddy/TLS
   * work required.
   */
  voiceServiceUrl?: string;
  /**
   * Hostname prefix for the voice bridge public URL. The resulting public
   * hostname is `${voiceHostnamePrefix}${businessId}.${hostnameSuffix}`
   * (default "voice-"). Using a prefix — rather than a separate subdomain —
   * keeps everything inside the existing delegated zone so only one CF API
   * token is ever needed.
   */
  voiceHostnamePrefix?: string;
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
    // Note: we do NOT use a destructuring default here. JS default initializers
    // only fire for `undefined`, but `.env` parsing and `cloudflareTunnelProvisionerFromEnv`
    // can both hand us an explicit empty string for an unset/blank key. An
    // empty-string default would produce `hostname = "${businessId}."` (a
    // trailing-dot label), which Cloudflare rejects as an invalid DNS record.
    // Coerce below so `""` collapses to the documented `zoneName` fallback.
    hostnameSuffix: rawHostnameSuffix,
    voiceServiceUrl: rawVoiceServiceUrl,
    voiceHostnamePrefix: rawVoiceHostnamePrefix,
    tunnelNamePrefix = "nc",
    fetchImpl = fetch
  } = config;

  if (!apiToken) throw new Error("CloudflareTunnelConfig.apiToken is required");
  if (!accountId) throw new Error("CloudflareTunnelConfig.accountId is required");
  if (!zoneName) throw new Error("CloudflareTunnelConfig.zoneName is required");
  if (!serviceUrl) throw new Error("CloudflareTunnelConfig.serviceUrl is required");

  const hostnameSuffix =
    typeof rawHostnameSuffix === "string" && rawHostnameSuffix.trim().length > 0
      ? rawHostnameSuffix.trim()
      : zoneName;
  // Same empty-string coercion pattern as hostnameSuffix above — `.env`
  // parsing can turn an unset key into "" instead of `undefined`, which would
  // otherwise bypass the intended defaults and produce an invalid ingress
  // service URL (`http://127.0.0.1:`) or a bare-dot hostname (`.<suffix>`).
  const voiceServiceUrl =
    typeof rawVoiceServiceUrl === "string" && rawVoiceServiceUrl.trim().length > 0
      ? rawVoiceServiceUrl.trim()
      : "http://127.0.0.1:8090";
  const voiceHostnamePrefix =
    typeof rawVoiceHostnamePrefix === "string" && rawVoiceHostnamePrefix.trim().length > 0
      ? rawVoiceHostnamePrefix.trim()
      : "voice-";

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

  async function ensureCnameRecord(params: {
    businessId: string;
    zoneId: string;
    hostname: string;
    cnameTarget: string;
    role: string;
  }): Promise<void> {
    const { businessId, zoneId, hostname, cnameTarget, role } = params;
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
          comment: `newCoworker orchestrator: business ${businessId} (${role})`
        })
      });
      logger.info("cloudflare DNS CNAME created", { businessId, role, hostname, cnameTarget });
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
      logger.info("cloudflare DNS CNAME updated", { businessId, role, hostname, cnameTarget });
    }
  }

  return async function provisionBusinessTunnel({ businessId }): Promise<ProvisionedTunnel> {
    if (!businessId) throw new Error("businessId required");
    const tunnelName = `${tunnelNamePrefix}-${businessId}`;
    const hostname = `${businessId}.${hostnameSuffix}`;
    const voiceHostname = `${voiceHostnamePrefix}${businessId}.${hostnameSuffix}`;

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

    // 3. Write the ingress rules. Two public hostnames on the same tunnel —
    //    one for Rowboat (app surface), one for the voice bridge (Telnyx media
    //    WebSocket). cloudflared on the VPS routes incoming requests to the
    //    right loopback port based on the incoming Host header. The catch-all
    //    404 entry is required by CF: ingress arrays must terminate with a
    //    rule that has no `hostname`.
    await api(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname, service: serviceUrl },
            { hostname: voiceHostname, service: voiceServiceUrl },
            { service: "http_status:404" }
          ]
        }
      })
    });

    // 4. Ensure both public hostname CNAMEs exist in the delegated zone. We
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
    await ensureCnameRecord({ businessId, zoneId, hostname, cnameTarget, role: "app" });
    await ensureCnameRecord({
      businessId,
      zoneId,
      hostname: voiceHostname,
      cnameTarget,
      role: "voice"
    });

    return { tunnelId, token, hostname, voiceHostname };
  };
}

export function cloudflareTunnelProvisionerFromEnv(
  env: Record<string, string | undefined> = process.env
): CloudflareTunnelProvisioner | null {
  // `dotenv` (and Vercel env pulls) returns the empty string "" for blank lines
  // like `CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX=` — which is exactly how .env.example
  // documents the optional keys. Coerce blank/whitespace strings to `undefined`
  // so the downstream `??` fallbacks and destructuring defaults actually fire.
  const blankToUndefined = (v: string | undefined): string | undefined => {
    if (typeof v !== "string") return undefined;
    const trimmed = v.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  };

  const apiToken = blankToUndefined(env.CLOUDFLARE_API_TOKEN);
  const accountId = blankToUndefined(env.CLOUDFLARE_ACCOUNT_ID);
  if (!apiToken || !accountId) return null;
  return createCloudflareTunnelProvisioner({
    apiToken,
    accountId,
    zoneName: blankToUndefined(env.CLOUDFLARE_TUNNEL_ZONE) ?? "tunnel.newcoworker.com",
    serviceUrl: blankToUndefined(env.CLOUDFLARE_TUNNEL_SERVICE_URL) ?? "http://localhost:3000",
    zoneId: blankToUndefined(env.CLOUDFLARE_ZONE_ID),
    hostnameSuffix: blankToUndefined(env.CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX),
    voiceServiceUrl: blankToUndefined(env.CLOUDFLARE_TUNNEL_VOICE_SERVICE_URL),
    voiceHostnamePrefix: blankToUndefined(env.CLOUDFLARE_TUNNEL_VOICE_HOSTNAME_PREFIX)
  });
}
