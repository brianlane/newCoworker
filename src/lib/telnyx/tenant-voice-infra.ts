/**
 * Per-tenant Telnyx voice infrastructure: one Call Control Application and
 * one Outbound Voice Profile per tenant, created (or adopted) at
 * provisioning time.
 *
 * Why: the fleet historically shared ONE app and ONE profile, so every
 * tenant contended for the same carrier-side concurrent-channel caps and a
 * runaway dialer in one tenant could starve everyone (2026-08-16 incident).
 * A dedicated pair gives each tenant carrier-enforced concurrency equal to
 * its plan promise, its own daily spend fuse, and blast-radius isolation.
 * Every app shares the SAME webhook URL: telnyx-voice-dispatch routes by the
 * dialed number, not by connection, so N apps need no routing changes.
 *
 * Idempotency: Telnyx creates are not idempotent, so both objects carry a
 * deterministic marker in their name, `[nc:<businessId>]`, and ensure runs
 * ADOPT an existing object found by that marker before ever creating.
 * Adoption also converges config: limits are PATCHed to the desired values
 * and the destination whitelist is widened as a MONOTONE UNION (never
 * narrowed; the Aug 6 2026 Canada outage came from a replace).
 *
 * The DB write (business_telnyx_settings ids) stays with the callers
 * (provisioning orchestrator, migration one-shot): this module talks only
 * to Telnyx.
 */
import { TelnyxApiError } from "./numbers";
import { allowedCountries } from "./voice-destinations";
import { VOICE_RES_LIMITS } from "../../../supabase/functions/_shared/voice_reservation_limits";
import { parseEnterpriseLimitsOverride } from "../plans/enterprise-limits";

const DEFAULT_BASE_URL = "https://api.telnyx.com/v2";

/** Per-tenant runaway fuse, mirroring the old fleet-wide $25/day limit. */
export const TENANT_PROFILE_DAILY_SPEND_LIMIT_USD = "25.00";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TelnyxVoiceInfraClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

export type CallControlApp = {
  id: string;
  application_name: string;
  webhook_event_url: string | null;
  outbound: { channel_limit: number | null; outbound_voice_profile_id: string | null };
};

export type OutboundVoiceProfile = {
  id: string;
  name: string;
  concurrent_call_limit: number | null;
  daily_spend_limit: string | null;
  daily_spend_limit_enabled: boolean;
  whitelisted_destinations: string[];
};

type AppWire = {
  id?: unknown;
  application_name?: unknown;
  webhook_event_url?: unknown;
  outbound?: { channel_limit?: unknown; outbound_voice_profile_id?: unknown } | null;
};

type ProfileWire = {
  id?: unknown;
  name?: unknown;
  concurrent_call_limit?: unknown;
  daily_spend_limit?: unknown;
  daily_spend_limit_enabled?: unknown;
  whitelisted_destinations?: unknown;
};

function readApp(raw: AppWire): CallControlApp {
  return {
    id: String(raw.id ?? ""),
    application_name: String(raw.application_name ?? ""),
    webhook_event_url:
      typeof raw.webhook_event_url === "string" ? raw.webhook_event_url : null,
    outbound: {
      channel_limit:
        typeof raw.outbound?.channel_limit === "number" ? raw.outbound.channel_limit : null,
      outbound_voice_profile_id:
        typeof raw.outbound?.outbound_voice_profile_id === "string"
          ? raw.outbound.outbound_voice_profile_id
          : null
    }
  };
}

function readProfile(raw: ProfileWire): OutboundVoiceProfile {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    concurrent_call_limit:
      typeof raw.concurrent_call_limit === "number" ? raw.concurrent_call_limit : null,
    daily_spend_limit: typeof raw.daily_spend_limit === "string" ? raw.daily_spend_limit : null,
    daily_spend_limit_enabled: raw.daily_spend_limit_enabled === true,
    whitelisted_destinations: Array.isArray(raw.whitelisted_destinations)
      ? raw.whitelisted_destinations.filter((c): c is string => typeof c === "string")
      : []
  };
}

export class TelnyxVoiceInfraClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: TelnyxVoiceInfraClientOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new Error("TelnyxVoiceInfraClient: apiKey is required");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    /* c8 ignore next -- abort callback fires only on real network timeout; tests don't stall */
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
      const text = await res.text();
      if (!res.ok) throw new TelnyxApiError(path, res.status, text);
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Apps whose name contains `needle` (the deterministic tenant marker). */
  async findCallControlAppsByName(needle: string): Promise<CallControlApp[]> {
    const params = new URLSearchParams();
    params.set("filter[application_name][contains]", needle);
    params.set("page[size]", "10");
    const json = await this.request<{ data?: AppWire[] }>(
      "GET",
      `/call_control_applications?${params.toString()}`
    );
    return (json.data ?? []).map(readApp);
  }

  async createCallControlApplication(opts: {
    name: string;
    webhookUrl: string;
    channelLimit: number;
    outboundVoiceProfileId: string;
  }): Promise<CallControlApp> {
    const json = await this.request<{ data: AppWire }>("POST", "/call_control_applications", {
      application_name: opts.name,
      webhook_event_url: opts.webhookUrl,
      webhook_api_version: "2",
      outbound: {
        channel_limit: opts.channelLimit,
        outbound_voice_profile_id: opts.outboundVoiceProfileId
      }
    });
    return readApp(json.data);
  }

  async patchCallControlApplicationOutbound(
    id: string,
    opts: { channelLimit: number; outboundVoiceProfileId: string; webhookUrl: string }
  ): Promise<CallControlApp> {
    const json = await this.request<{ data: AppWire }>(
      "PATCH",
      `/call_control_applications/${encodeURIComponent(id)}`,
      {
        webhook_event_url: opts.webhookUrl,
        outbound: {
          channel_limit: opts.channelLimit,
          outbound_voice_profile_id: opts.outboundVoiceProfileId
        }
      }
    );
    return readApp(json.data);
  }

  /** Profiles whose name contains `needle` (the deterministic tenant marker). */
  async findOutboundVoiceProfilesByName(needle: string): Promise<OutboundVoiceProfile[]> {
    const params = new URLSearchParams();
    params.set("filter[name][contains]", needle);
    params.set("page[size]", "10");
    const json = await this.request<{ data?: ProfileWire[] }>(
      "GET",
      `/outbound_voice_profiles?${params.toString()}`
    );
    return (json.data ?? []).map(readProfile);
  }

  async createOutboundVoiceProfile(opts: {
    name: string;
    concurrentCallLimit: number;
    dailySpendLimitUsd: string;
    whitelistedDestinations: string[];
  }): Promise<OutboundVoiceProfile> {
    const json = await this.request<{ data: ProfileWire }>("POST", "/outbound_voice_profiles", {
      name: opts.name,
      concurrent_call_limit: opts.concurrentCallLimit,
      daily_spend_limit: opts.dailySpendLimitUsd,
      daily_spend_limit_enabled: true,
      whitelisted_destinations: opts.whitelistedDestinations
    });
    return readProfile(json.data);
  }

  async patchOutboundVoiceProfile(
    id: string,
    opts: {
      concurrentCallLimit: number;
      dailySpendLimitUsd: string;
      whitelistedDestinations: string[];
    }
  ): Promise<OutboundVoiceProfile> {
    const json = await this.request<{ data: ProfileWire }>(
      "PATCH",
      `/outbound_voice_profiles/${encodeURIComponent(id)}`,
      {
        concurrent_call_limit: opts.concurrentCallLimit,
        daily_spend_limit: opts.dailySpendLimitUsd,
        daily_spend_limit_enabled: true,
        whitelisted_destinations: opts.whitelistedDestinations
      }
    );
    return readProfile(json.data);
  }
}

/**
 * The tenant's carrier-facing concurrency: the tier's maxConcurrentCalls,
 * with the enterprise per-deal override honored. Same source of truth as the
 * app-side reservation gate (VOICE_RES_LIMITS), so the carrier cap and the
 * platform cap can never disagree about the plan promise.
 */
export function resolveTenantMaxConcurrentCalls(
  tier: string | null | undefined,
  enterpriseLimitsRaw: unknown
): number {
  const t = tier === "standard" || tier === "enterprise" ? tier : "starter";
  if (t === "enterprise") {
    const override = parseEnterpriseLimitsOverride(enterpriseLimitsRaw);
    if (override?.maxConcurrentCalls !== undefined) return override.maxConcurrentCalls;
  }
  return VOICE_RES_LIMITS[t].maxConcurrentCalls;
}

/** Deterministic, searchable marker every tenant object carries in its name. */
export function tenantInfraMarker(businessId: string): string {
  return `[nc:${businessId}]`;
}

/** Telnyx rejects app/profile names over 64 chars (error 10015). */
export const TELNYX_NAME_MAX_CHARS = 64;

/**
 * Portal-readable object name: trimmed tenant name plus the marker, with the
 * TOTAL clamped to Telnyx's 64-char limit. The marker is the part adoption
 * searches by, so the display name is what gets truncated ("Amy Laidlaw Real
 * Estate" plus a uuid marker is 65 chars, which 422'd the first live apply).
 */
export function tenantInfraName(businessName: string, businessId: string): string {
  const marker = tenantInfraMarker(businessId);
  const clean = businessName.trim().replace(/\s+/g, " ");
  const maxBase = Math.max(1, TELNYX_NAME_MAX_CHARS - marker.length - 1);
  const base = (clean.length > 0 ? clean : "Tenant").slice(0, maxBase).trimEnd();
  return `${base} ${marker}`;
}

/** The one webhook URL every app points at; dispatch routes by dialed number. */
export function voiceDispatchWebhookUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/functions/v1/telnyx-voice-dispatch`;
}

export type EnsureTenantVoiceInfraInput = {
  businessId: string;
  businessName: string;
  /** Carrier-enforced concurrency = the tenant's plan promise. */
  maxConcurrentCalls: number;
  webhookUrl: string;
  /** When set, the DID is re-pointed onto the tenant app. */
  didE164?: string | null;
  dailySpendLimitUsd?: string;
  whitelistedDestinations?: string[];
};

export type TenantVoiceInfraResult = {
  connectionId: string;
  outboundVoiceProfileId: string;
  createdApp: boolean;
  createdProfile: boolean;
};

/** The one numbers-client method this module needs (structural, for tests). */
export type DidRepointer = {
  updatePhoneNumber(opts: {
    phoneNumberIdOrE164: string;
    connectionId?: string | null;
  }): Promise<unknown>;
};

/**
 * The client surface ensureTenantVoiceInfra consumes. A Pick of the class so
 * the real client satisfies it while tests inject plain method objects (the
 * class's private fields would otherwise make the type nominal).
 */
export type TenantVoiceInfraApi = Pick<
  TelnyxVoiceInfraClient,
  | "findCallControlAppsByName"
  | "createCallControlApplication"
  | "patchCallControlApplicationOutbound"
  | "findOutboundVoiceProfilesByName"
  | "createOutboundVoiceProfile"
  | "patchOutboundVoiceProfile"
>;

/**
 * Create-or-adopt the tenant's dedicated app + profile and (optionally)
 * point the DID at the app. Safe to re-run: adoption converges limits and
 * widens the whitelist monotonically. Throws on Telnyx errors; callers
 * decide whether that aborts (one-shot) or degrades to the shared platform
 * app (provisioning).
 */
export async function ensureTenantVoiceInfra(
  deps: { infra: TenantVoiceInfraApi; numbers?: DidRepointer },
  input: EnsureTenantVoiceInfraInput
): Promise<TenantVoiceInfraResult> {
  if (!Number.isInteger(input.maxConcurrentCalls) || input.maxConcurrentCalls < 1) {
    throw new Error(
      `ensureTenantVoiceInfra: maxConcurrentCalls must be a positive integer, got ${input.maxConcurrentCalls}`
    );
  }
  const marker = tenantInfraMarker(input.businessId);
  const name = tenantInfraName(input.businessName, input.businessId);
  const spendLimit = input.dailySpendLimitUsd ?? TENANT_PROFILE_DAILY_SPEND_LIMIT_USD;
  const whitelist = input.whitelistedDestinations ?? allowedCountries();

  // Profile first: the app references it at create time.
  const existingProfiles = await deps.infra.findOutboundVoiceProfilesByName(marker);
  let profile = existingProfiles[0];
  let createdProfile = false;
  if (!profile) {
    profile = await deps.infra.createOutboundVoiceProfile({
      name,
      concurrentCallLimit: input.maxConcurrentCalls,
      dailySpendLimitUsd: spendLimit,
      whitelistedDestinations: whitelist
    });
    createdProfile = true;
  } else {
    // Converge limits; WIDEN the whitelist (union), never narrow it.
    const mergedWhitelist = [
      ...new Set([...profile.whitelisted_destinations, ...whitelist])
    ].sort();
    const drift =
      profile.concurrent_call_limit !== input.maxConcurrentCalls ||
      profile.daily_spend_limit !== spendLimit ||
      profile.daily_spend_limit_enabled !== true ||
      mergedWhitelist.length !== profile.whitelisted_destinations.length;
    if (drift) {
      profile = await deps.infra.patchOutboundVoiceProfile(profile.id, {
        concurrentCallLimit: input.maxConcurrentCalls,
        dailySpendLimitUsd: spendLimit,
        whitelistedDestinations: mergedWhitelist
      });
    }
  }

  const existingApps = await deps.infra.findCallControlAppsByName(marker);
  let app = existingApps[0];
  let createdApp = false;
  if (!app) {
    app = await deps.infra.createCallControlApplication({
      name,
      webhookUrl: input.webhookUrl,
      channelLimit: input.maxConcurrentCalls,
      outboundVoiceProfileId: profile.id
    });
    createdApp = true;
  } else {
    const drift =
      app.outbound.channel_limit !== input.maxConcurrentCalls ||
      app.outbound.outbound_voice_profile_id !== profile.id ||
      app.webhook_event_url !== input.webhookUrl;
    if (drift) {
      app = await deps.infra.patchCallControlApplicationOutbound(app.id, {
        channelLimit: input.maxConcurrentCalls,
        outboundVoiceProfileId: profile.id,
        webhookUrl: input.webhookUrl
      });
    }
  }

  if (input.didE164 && deps.numbers) {
    await deps.numbers.updatePhoneNumber({
      phoneNumberIdOrE164: input.didE164,
      connectionId: app.id
    });
  }

  return {
    connectionId: app.id,
    outboundVoiceProfileId: profile.id,
    createdApp,
    createdProfile
  };
}
