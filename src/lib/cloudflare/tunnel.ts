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
// Zone topology assumed: a CF-managed zone (e.g. newcoworker.com) hosting the
// apex. We publish per-tenant hostnames at `<businessId>.<zone>` — ONE level
// under the zone — so Cloudflare's free Universal SSL cert
// (covers apex + `*.<zone>`) handles edge TLS for every tenant without paid
// Total TLS / Advanced Certificate Manager.
//
// Going deeper than one level (e.g. `<biz>.tunnel.<zone>`) is supported via
// `CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX`, but only if the operator has upgraded
// to a paid plan and enabled Total TLS — Universal SSL's wildcard does not
// span more than one level.

import { logger } from "@/lib/logger";

export type ProvisionedTunnel = {
  tunnelId: string;
  token: string;
  /** Public hostname forwarding to `serviceUrl` (e.g. Rowboat on :3000). */
  hostname: string;
  /** Public hostname forwarding to `voiceServiceUrl` (voice bridge on :8090). */
  voiceHostname: string;
  /**
   * Public hostname forwarding to `renderServiceUrl` (AiFlow render service on
   * :8080). Only present when `renderEnabled` was passed for this tenant — the
   * render sidecar is gated to larger tiers (NOT the starter/KVM2 box), so the
   * ingress rule + CNAME are created only where the container actually runs.
   */
  renderHostname?: string;
  /**
   * Public hostname forwarding to `dataServiceUrl` (the residency data API on
   * :8091). Only present when `dataEnabled` was passed — the data-api stack is
   * deployed exclusively for enterprise tenants with data residency switched
   * on, so the hostname exists only where the container actually runs.
   */
  dataHostname?: string;
};

export type CloudflareTunnelProvisioner = (input: {
  businessId: string;
  /**
   * Whether to publish the AiFlow render-service hostname for this tenant.
   * The render sidecar (headless Chromium) is intentionally NOT deployed on
   * the starter/KVM2 tier, so callers pass `false` there to avoid creating a
   * public hostname that would resolve to a non-existent backend.
   */
  renderEnabled?: boolean;
  /**
   * Whether to publish the residency data-API hostname for this tenant.
   * Deployed exclusively for enterprise tenants whose `data_residency_mode`
   * is past 'supabase' — everyone else gets no hostname and no backend.
   */
  dataEnabled?: boolean;
}) => Promise<ProvisionedTunnel>;

export type CloudflareTunnelConfig = {
  apiToken: string;
  /**
   * Optional separate API token used ONLY for the Total TLS PATCH (and
   * any future zone-level SSL operations). Cloudflare's Account-scoped
   * tokens that already work for tunnels + DNS routinely lack the
   * `Zone:SSL and Certificates:Edit` permission needed for
   * `PATCH /zones/<id>/acm/total_tls`, so we accept a second token
   * scoped specifically to that surface and fall back to `apiToken` when
   * unset (production behaviour pre-rotation). Surfaced via env as
   * `CLOUDFLARE_SSL_API_TOKEN` in `cloudflareTunnelProvisionerFromEnv`.
   */
  sslApiToken?: string;
  accountId: string;
  /**
   * The CF DNS zone that owns the public hostname (e.g. "newcoworker.com").
   * Used for the `GET /zones?name=…` lookup.
   */
  zoneName: string;
  /**
   * Suffix appended to `businessId` to form the public hostname. Defaults to
   * `zoneName` itself, producing `<businessId>.<zone>` (one wildcard level —
   * covered by free Universal SSL). Override only if you've upgraded to a
   * paid plan with Total TLS and need a deeper namespace, e.g. zoneName
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
   * Local AiFlow render-service URL (default "http://127.0.0.1:8080"). When a
   * tenant has the render sidecar (non-starter tiers), the tunnel publishes it
   * behind a dedicated public hostname so Supabase Edge (the ai-flow-worker)
   * can reach it with a CF-issued cert — same pattern as the voice bridge.
   */
  renderServiceUrl?: string;
  /**
   * Hostname prefix for the render-service public URL. The resulting public
   * hostname is `${renderHostnamePrefix}${businessId}.${hostnameSuffix}`
   * (default "render-"). Like the voice prefix, staying inside the existing
   * delegated zone keeps everything under the one free Universal SSL wildcard.
   */
  renderHostnamePrefix?: string;
  /**
   * Local residency data-API URL (default "http://127.0.0.1:8091"). When an
   * enterprise tenant has residency enabled, the tunnel publishes it behind a
   * dedicated public hostname so the dashboard + Supabase Edge can reach the
   * box datastore with a CF-issued cert — same pattern as voice/render.
   */
  dataServiceUrl?: string;
  /**
   * Hostname prefix for the data-API public URL. The resulting public
   * hostname is `${dataHostnamePrefix}${businessId}.${hostnameSuffix}`
   * (default "data-") — one wildcard level, covered by free Universal SSL.
   */
  dataHostnamePrefix?: string;
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
    sslApiToken,
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
    renderServiceUrl: rawRenderServiceUrl,
    renderHostnamePrefix: rawRenderHostnamePrefix,
    dataServiceUrl: rawDataServiceUrl,
    dataHostnamePrefix: rawDataHostnamePrefix,
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
  // Same empty-string coercion as the voice equivalents above.
  const renderServiceUrl =
    typeof rawRenderServiceUrl === "string" && rawRenderServiceUrl.trim().length > 0
      ? rawRenderServiceUrl.trim()
      : "http://127.0.0.1:8080";
  const renderHostnamePrefix =
    typeof rawRenderHostnamePrefix === "string" && rawRenderHostnamePrefix.trim().length > 0
      ? rawRenderHostnamePrefix.trim()
      : "render-";
  // Same empty-string coercion as the voice/render equivalents above.
  const dataServiceUrl =
    typeof rawDataServiceUrl === "string" && rawDataServiceUrl.trim().length > 0
      ? rawDataServiceUrl.trim()
      : "http://127.0.0.1:8091";
  const dataHostnamePrefix =
    typeof rawDataHostnamePrefix === "string" && rawDataHostnamePrefix.trim().length > 0
      ? rawDataHostnamePrefix.trim()
      : "data-";

  /**
   * Cloudflare API caller. The `tokenOverride` parameter lets specific
   * call sites (notably `ensureZoneTotalTls`) reach for a more privileged
   * token than the default tunnel-scoped one without exposing that token
   * to every other call. Any path that doesn't pass `tokenOverride`
   * uses `apiToken` (the tunnel/DNS scope) — preserving the principle
   * of least privilege on every request.
   */
  async function api<T>(
    path: string,
    init?: RequestInit,
    tokenOverride?: string
  ): Promise<T> {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${tokenOverride ?? apiToken}`,
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

  /**
   * Enable Cloudflare Total TLS on a zone (idempotent).
   *
   * IMPORTANT: this is an OPTIONAL paid-plan opt-in, not a default
   * dependency. Our hostname pattern is `<businessId>.<zoneName>` —
   * ONE level under the zone — which Universal SSL covers automatically
   * on every plan including Free. Total TLS is only required if an
   * operator chooses to nest tunnel hostnames deeper (e.g. by setting
   * `CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX=tunnel.newcoworker.com`, which
   * produces `<biz>.tunnel.<root>` — two levels deep — and would hit
   * `sslv3 alert handshake failure` without per-hostname certs).
   *
   * Total TLS itself ships as part of Advanced Certificate Manager
   * ($10/mo/zone on Pro+) and lazily issues a Let's Encrypt cert per
   * hostname as soon as a CNAME for it is created in the zone — exactly
   * when our `ensureCnameRecord` runs below.
   *
   * The PATCH is idempotent: re-enabling on a zone that already has it
   * on returns 200 with the same body. A 4xx here (including the
   * Free-plan `403 / requires Advanced Certificate Manager` response)
   * is logged and swallowed because cert provisioning is independent
   * of tunnel functionality on the data plane (the tunnel still
   * proxies; only edge TLS would be affected), and we never want a
   * cert-API hiccup to abort an otherwise-successful provision.
   */
  async function ensureZoneTotalTls(zoneId: string, businessId: string): Promise<void> {
    try {
      // Prefer the SSL-scoped token (CLOUDFLARE_SSL_API_TOKEN) when one
      // was supplied. The tunnel-scoped `apiToken` typically has Tunnel
      // + DNS Edit but NOT Zone:SSL:Edit, which is why the production
      // PATCH was returning `10405 Method not allowed for this auth
      // scheme` until the operator rotated to a separate token. Falling
      // through to `apiToken` keeps backward compatibility for setups
      // that grant SSL scope to the same token.
      await api(
        `/zones/${zoneId}/acm/total_tls`,
        {
          method: "PATCH",
          body: JSON.stringify({
            enabled: true,
            /* Let's Encrypt is the only CA that supports Total TLS today and
               is also free; locking the choice keeps the API contract stable
               across re-runs against zones provisioners may have inherited. */
            certificate_authority: "lets_encrypt"
          })
        },
        sslApiToken && sslApiToken.length > 0 ? sslApiToken : undefined
      );
      logger.info("cloudflare Total TLS enabled", { businessId, zoneId });
    } catch (err) {
      // `api()` only ever throws Error subclasses (see line 153 — `throw new
      // Error(...)`), so `instanceof Error` is always true here. The
      // `: String(err)` branch is a defensive narrowing aid for a
      // hypothetical future caller that throws a non-Error value, and
      // unreachable from any path the provisioner exercises today.
      const message = err instanceof Error ? err.message : /* c8 ignore next */ String(err);
      logger.warn("cloudflare Total TLS PATCH failed (non-fatal)", {
        businessId,
        zoneId,
        error: message
      });
    }
  }

  return async function provisionBusinessTunnel({
    businessId,
    renderEnabled = false,
    dataEnabled = false
  }): Promise<ProvisionedTunnel> {
    if (!businessId) throw new Error("businessId required");
    const tunnelName = `${tunnelNamePrefix}-${businessId}`;
    const hostname = `${businessId}.${hostnameSuffix}`;
    const voiceHostname = `${voiceHostnamePrefix}${businessId}.${hostnameSuffix}`;
    // Only materialized on render-capable tiers; left undefined on starter/KVM2
    // so no public hostname points at a backend that isn't running there.
    const renderHostname = renderEnabled
      ? `${renderHostnamePrefix}${businessId}.${hostnameSuffix}`
      : undefined;
    // Only materialized for residency-enabled enterprise tenants.
    const dataHostname = dataEnabled
      ? `${dataHostnamePrefix}${businessId}.${hostnameSuffix}`
      : undefined;

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
    const ingress: Array<{ hostname?: string; service: string }> = [
      { hostname, service: serviceUrl },
      { hostname: voiceHostname, service: voiceServiceUrl }
    ];
    if (renderHostname) {
      ingress.push({ hostname: renderHostname, service: renderServiceUrl });
    }
    if (dataHostname) {
      ingress.push({ hostname: dataHostname, service: dataServiceUrl });
    }
    // CF requires the ingress array to terminate with a hostname-less catch-all.
    ingress.push({ service: "http_status:404" });
    await api(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify({ config: { ingress } })
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
    if (renderHostname) {
      await ensureCnameRecord({
        businessId,
        zoneId,
        hostname: renderHostname,
        cnameTarget,
        role: "render"
      });
    }
    if (dataHostname) {
      await ensureCnameRecord({
        businessId,
        zoneId,
        hostname: dataHostname,
        cnameTarget,
        role: "data"
      });
    }

    // 5. Best-effort Total TLS opt-in. With our default one-wildcard-level
    //    hostname pattern (`<biz>.<zone>`), free Universal SSL already
    //    covers both freshly-CNAMEd hostnames, so this is a no-op on Free.
    //    Operators who deliberately nest hostnames deeper via
    //    `CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX` need this to succeed (paid
    //    plan + ACM required). Idempotent + non-fatal — see
    //    `ensureZoneTotalTls` for why we swallow API errors here.
    await ensureZoneTotalTls(zoneId, businessId);

    return { tunnelId, token, hostname, voiceHostname, renderHostname, dataHostname };
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
    // Optional separately-scoped token for `Zone:SSL and Certificates:Edit`
    // (Total TLS PATCH). When unset, `ensureZoneTotalTls` falls back to
    // `apiToken` — which is fine if that token already grants SSL scope,
    // and silently no-ops (logs a warn) when it doesn't. The split exists
    // so operators can keep the tunnel/DNS token narrowly-scoped while
    // still letting the provisioner enable Total TLS without manual
    // dashboard work.
    sslApiToken: blankToUndefined(env.CLOUDFLARE_SSL_API_TOKEN),
    accountId,
    zoneName: blankToUndefined(env.CLOUDFLARE_TUNNEL_ZONE) ?? "newcoworker.com",
    serviceUrl: blankToUndefined(env.CLOUDFLARE_TUNNEL_SERVICE_URL) ?? "http://localhost:3000",
    zoneId: blankToUndefined(env.CLOUDFLARE_ZONE_ID),
    hostnameSuffix: blankToUndefined(env.CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX),
    voiceServiceUrl: blankToUndefined(env.CLOUDFLARE_TUNNEL_VOICE_SERVICE_URL),
    voiceHostnamePrefix: blankToUndefined(env.CLOUDFLARE_TUNNEL_VOICE_HOSTNAME_PREFIX),
    renderServiceUrl: blankToUndefined(env.CLOUDFLARE_TUNNEL_RENDER_SERVICE_URL),
    renderHostnamePrefix: blankToUndefined(env.CLOUDFLARE_TUNNEL_RENDER_HOSTNAME_PREFIX),
    dataServiceUrl: blankToUndefined(env.CLOUDFLARE_TUNNEL_DATA_SERVICE_URL),
    dataHostnamePrefix: blankToUndefined(env.CLOUDFLARE_TUNNEL_DATA_HOSTNAME_PREFIX)
  });
}
