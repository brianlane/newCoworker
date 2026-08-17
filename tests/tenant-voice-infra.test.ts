import { describe, expect, it, vi } from "vitest";
import {
  TENANT_PROFILE_DAILY_SPEND_LIMIT_USD,
  TelnyxVoiceInfraClient,
  ensureTenantVoiceInfra,
  resolveTenantMaxConcurrentCalls,
  tenantInfraMarker,
  tenantInfraName,
  voiceDispatchWebhookUrl,
  type CallControlApp,
  type OutboundVoiceProfile,
  type TenantVoiceInfraApi
} from "@/lib/telnyx/tenant-voice-infra";
import { TelnyxApiError } from "@/lib/telnyx/numbers";
import { VOICE_RES_LIMITS } from "../supabase/functions/_shared/voice_reservation_limits";
import {
  LIVE_TRAFFIC_REGIONS,
  allowedCountries
} from "@/lib/telnyx/voice-destinations";
import * as allowlistShim from "../scripts/oneshot/widen-telnyx-allowlist";

const BIZ = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body))
  } as unknown as Response;
}

describe("TelnyxVoiceInfraClient", () => {
  it("requires an api key", () => {
    expect(() => new TelnyxVoiceInfraClient({ apiKey: " " })).toThrow(/apiKey is required/);
  });

  it("finds apps by the name marker with the contains filter", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        data: [
          {
            id: "app-1",
            application_name: `Amy [nc:${BIZ}]`,
            webhook_event_url: "https://x.supabase.co/functions/v1/telnyx-voice-dispatch",
            outbound: { channel_limit: 10, outbound_voice_profile_id: "prof-1" }
          },
          { id: "app-2" }
        ]
      })
    );
    const client = new TelnyxVoiceInfraClient({ apiKey: "k", fetchImpl });
    const apps = await client.findCallControlAppsByName(`[nc:${BIZ}]`);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/call_control_applications?");
    expect(decodeURIComponent(url)).toContain(`filter[application_name][contains]=[nc:${BIZ}]`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(apps[0]).toEqual({
      id: "app-1",
      application_name: `Amy [nc:${BIZ}]`,
      webhook_event_url: "https://x.supabase.co/functions/v1/telnyx-voice-dispatch",
      outbound: { channel_limit: 10, outbound_voice_profile_id: "prof-1" }
    });
    // Malformed entry coerces to nulls rather than crashing.
    expect(apps[1]).toEqual({
      id: "app-2",
      application_name: "",
      webhook_event_url: null,
      outbound: { channel_limit: null, outbound_voice_profile_id: null }
    });
  });

  it("returns [] when the list payload has no data array", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const client = new TelnyxVoiceInfraClient({ apiKey: "k", fetchImpl });
    expect(await client.findCallControlAppsByName("x")).toEqual([]);
    expect(await client.findOutboundVoiceProfilesByName("x")).toEqual([]);
  });

  it("creates an app with webhook + outbound settings", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          id: "app-9",
          application_name: "n",
          webhook_event_url: "https://w",
          outbound: { channel_limit: 10, outbound_voice_profile_id: "p-9" }
        }
      })
    );
    const client = new TelnyxVoiceInfraClient({ apiKey: "k", fetchImpl });
    const app = await client.createCallControlApplication({
      name: "n",
      webhookUrl: "https://w",
      channelLimit: 10,
      outboundVoiceProfileId: "p-9"
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/call_control_applications");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      application_name: "n",
      webhook_event_url: "https://w",
      webhook_api_version: "2",
      outbound: { channel_limit: 10, outbound_voice_profile_id: "p-9" }
    });
    expect(app.id).toBe("app-9");
  });

  it("patches app outbound config (encoding the id)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: { id: "app 1", outbound: {} } })
    );
    const client = new TelnyxVoiceInfraClient({ apiKey: "k", fetchImpl });
    await client.patchCallControlApplicationOutbound("app 1", {
      channelLimit: 5,
      outboundVoiceProfileId: "p",
      webhookUrl: "https://w"
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/call_control_applications/app%201");
    expect(init.method).toBe("PATCH");
  });

  it("creates and patches profiles with the spend fuse enabled", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          id: "p-1",
          name: "n",
          concurrent_call_limit: 10,
          daily_spend_limit: "25.00",
          daily_spend_limit_enabled: true,
          whitelisted_destinations: ["CA", "US"]
        }
      })
    );
    const client = new TelnyxVoiceInfraClient({ apiKey: "k", fetchImpl });
    const created = await client.createOutboundVoiceProfile({
      name: "n",
      concurrentCallLimit: 10,
      dailySpendLimitUsd: "25.00",
      whitelistedDestinations: ["US", "CA"]
    });
    expect(created.daily_spend_limit_enabled).toBe(true);
    await client.patchOutboundVoiceProfile("p-1", {
      concurrentCallLimit: 12,
      dailySpendLimitUsd: "25.00",
      whitelistedDestinations: ["US", "CA"]
    });
    const [, patchInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(patchInit.body))).toMatchObject({
      concurrent_call_limit: 12,
      daily_spend_limit_enabled: true
    });
  });

  it("throws TelnyxApiError with status and body on a non-2xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(422, { errors: [{ code: "10015" }] }));
    const client = new TelnyxVoiceInfraClient({ apiKey: "k", fetchImpl });
    await expect(client.findCallControlAppsByName("x")).rejects.toMatchObject({
      name: "TelnyxApiError",
      status: 422
    });
    await expect(client.findCallControlAppsByName("x")).rejects.toBeInstanceOf(TelnyxApiError);
  });

  it("treats an empty response body as an empty object", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, undefined));
    const client = new TelnyxVoiceInfraClient({ apiKey: "k", fetchImpl });
    expect(await client.findOutboundVoiceProfilesByName("x")).toEqual([]);
  });

  // Wire-shape hardening: Telnyx fields of the WRONG type must coerce to
  // safe nulls/empties, never crash the adopt path mid-provisioning.
  it("coerces malformed wire payloads to safe values", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            {
              id: 7,
              application_name: null,
              webhook_event_url: 42,
              outbound: { channel_limit: "10", outbound_voice_profile_id: 99 }
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [
            {
              id: 8,
              name: undefined,
              concurrent_call_limit: "10",
              daily_spend_limit: 25,
              daily_spend_limit_enabled: "yes",
              whitelisted_destinations: ["US", 12, null, "CA"]
            },
            { id: 9, whitelisted_destinations: "US" }
          ]
        })
      );
    const client = new TelnyxVoiceInfraClient({ apiKey: "k", fetchImpl });
    const [app] = await client.findCallControlAppsByName("x");
    expect(app).toEqual({
      id: "7",
      application_name: "",
      webhook_event_url: null,
      outbound: { channel_limit: null, outbound_voice_profile_id: null }
    });
    // A wholly empty entry coerces to empty-string ids, not a crash.
    const fetchEmpty = vi.fn(async () => jsonResponse(200, { data: [{}] }));
    const clientEmpty = new TelnyxVoiceInfraClient({ apiKey: "k", fetchImpl: fetchEmpty });
    expect((await clientEmpty.findCallControlAppsByName("x"))[0]!.id).toBe("");
    expect((await clientEmpty.findOutboundVoiceProfilesByName("x"))[0]!.id).toBe("");
    const [profile, sparse] = await client.findOutboundVoiceProfilesByName("x");
    expect(profile).toEqual({
      id: "8",
      name: "",
      concurrent_call_limit: null,
      daily_spend_limit: null,
      daily_spend_limit_enabled: false,
      whitelisted_destinations: ["US", "CA"]
    });
    expect(sparse!.whitelisted_destinations).toEqual([]);
  });
});

describe("naming + webhook helpers", () => {
  it("builds a deterministic marker and a readable name", () => {
    expect(tenantInfraMarker(BIZ)).toBe(`[nc:${BIZ}]`);
    expect(tenantInfraName("  Amy   Laidlaw  Real Estate ", BIZ)).toBe(
      `Amy Laidlaw Real Estate [nc:${BIZ}]`
    );
  });

  it("falls back to Tenant for an empty name and truncates very long ones", () => {
    expect(tenantInfraName("   ", BIZ)).toBe(`Tenant [nc:${BIZ}]`);
    const long = "x".repeat(200);
    expect(tenantInfraName(long, BIZ).length).toBeLessThan(200);
    expect(tenantInfraName(long, BIZ)).toContain(`[nc:${BIZ}]`);
  });

  it("derives the dispatch webhook URL, trimming a trailing slash", () => {
    expect(voiceDispatchWebhookUrl("https://x.supabase.co/")).toBe(
      "https://x.supabase.co/functions/v1/telnyx-voice-dispatch"
    );
  });
});

describe("resolveTenantMaxConcurrentCalls", () => {
  it("maps tiers to VOICE_RES_LIMITS (unknown/garbage falls to starter)", () => {
    expect(resolveTenantMaxConcurrentCalls("starter", null)).toBe(
      VOICE_RES_LIMITS.starter.maxConcurrentCalls
    );
    expect(resolveTenantMaxConcurrentCalls("standard", null)).toBe(
      VOICE_RES_LIMITS.standard.maxConcurrentCalls
    );
    expect(resolveTenantMaxConcurrentCalls("enterprise", null)).toBe(
      VOICE_RES_LIMITS.enterprise.maxConcurrentCalls
    );
    expect(resolveTenantMaxConcurrentCalls("gold", null)).toBe(
      VOICE_RES_LIMITS.starter.maxConcurrentCalls
    );
    expect(resolveTenantMaxConcurrentCalls(null, null)).toBe(
      VOICE_RES_LIMITS.starter.maxConcurrentCalls
    );
  });

  it("honors the enterprise per-deal override, ignoring invalid shapes", () => {
    expect(resolveTenantMaxConcurrentCalls("enterprise", { maxConcurrentCalls: 25 })).toBe(25);
    expect(resolveTenantMaxConcurrentCalls("enterprise", { maxConcurrentCalls: -1 })).toBe(
      VOICE_RES_LIMITS.enterprise.maxConcurrentCalls
    );
    // Overrides only apply on enterprise: a standard tenant's row is ignored.
    expect(resolveTenantMaxConcurrentCalls("standard", { maxConcurrentCalls: 25 })).toBe(
      VOICE_RES_LIMITS.standard.maxConcurrentCalls
    );
  });
});

describe("voice-destinations canonical list", () => {
  it("keeps live-traffic regions present and the shim re-exporting it", () => {
    const allowed = allowedCountries();
    for (const region of LIVE_TRAFFIC_REGIONS) expect(allowed).toContain(region);
    expect(allowed.length).toBeGreaterThan(50);
    // The one-shot shim must expose the same function object: a fork of the
    // list is exactly what caused the Aug 6 2026 Canada outage.
    expect(allowlistShim.allowedCountries).toBe(allowedCountries);
  });
});

type FakeInfra = TenantVoiceInfraApi & {
  calls: Record<string, unknown[]>;
};

function fakeInfra(state: {
  profiles?: OutboundVoiceProfile[];
  apps?: CallControlApp[];
}): FakeInfra {
  const calls: Record<string, unknown[]> = {
    findProfiles: [],
    createProfile: [],
    patchProfile: [],
    findApps: [],
    createApp: [],
    patchApp: []
  };
  return {
    calls,
    async findOutboundVoiceProfilesByName(needle: string) {
      calls.findProfiles!.push(needle);
      return state.profiles ?? [];
    },
    async createOutboundVoiceProfile(opts) {
      calls.createProfile!.push(opts);
      return {
        id: "prof-new",
        name: opts.name,
        concurrent_call_limit: opts.concurrentCallLimit,
        daily_spend_limit: opts.dailySpendLimitUsd,
        daily_spend_limit_enabled: true,
        whitelisted_destinations: opts.whitelistedDestinations
      };
    },
    async patchOutboundVoiceProfile(id, opts) {
      calls.patchProfile!.push({ id, ...opts });
      return {
        id,
        name: "patched",
        concurrent_call_limit: opts.concurrentCallLimit,
        daily_spend_limit: opts.dailySpendLimitUsd,
        daily_spend_limit_enabled: true,
        whitelisted_destinations: opts.whitelistedDestinations
      };
    },
    async findCallControlAppsByName(needle: string) {
      calls.findApps!.push(needle);
      return state.apps ?? [];
    },
    async createCallControlApplication(opts) {
      calls.createApp!.push(opts);
      return {
        id: "app-new",
        application_name: opts.name,
        webhook_event_url: opts.webhookUrl,
        outbound: {
          channel_limit: opts.channelLimit,
          outbound_voice_profile_id: opts.outboundVoiceProfileId
        }
      };
    },
    async patchCallControlApplicationOutbound(id, opts) {
      calls.patchApp!.push({ id, ...opts });
      return {
        id,
        application_name: "patched",
        webhook_event_url: opts.webhookUrl,
        outbound: {
          channel_limit: opts.channelLimit,
          outbound_voice_profile_id: opts.outboundVoiceProfileId
        }
      };
    }
  };
}

const WEBHOOK = "https://x.supabase.co/functions/v1/telnyx-voice-dispatch";
const INPUT = {
  businessId: BIZ,
  businessName: "Amy Laidlaw Real Estate",
  maxConcurrentCalls: 10,
  webhookUrl: WEBHOOK,
  whitelistedDestinations: ["CA", "MX", "US"]
};

function adoptableProfile(overrides: Partial<OutboundVoiceProfile> = {}): OutboundVoiceProfile {
  return {
    id: "prof-old",
    name: `Amy Laidlaw Real Estate ${tenantInfraMarker(BIZ)}`,
    concurrent_call_limit: 10,
    daily_spend_limit: TENANT_PROFILE_DAILY_SPEND_LIMIT_USD,
    daily_spend_limit_enabled: true,
    whitelisted_destinations: ["CA", "MX", "US"],
    ...overrides
  };
}

function adoptableApp(overrides: Partial<CallControlApp> = {}): CallControlApp {
  return {
    id: "app-old",
    application_name: `Amy Laidlaw Real Estate ${tenantInfraMarker(BIZ)}`,
    webhook_event_url: WEBHOOK,
    outbound: { channel_limit: 10, outbound_voice_profile_id: "prof-old" },
    ...overrides
  };
}

describe("ensureTenantVoiceInfra", () => {
  it("rejects a non-positive or fractional concurrency", async () => {
    const infra = fakeInfra({});
    await expect(
      ensureTenantVoiceInfra({ infra }, { ...INPUT, maxConcurrentCalls: 0 })
    ).rejects.toThrow(/positive integer/);
    await expect(
      ensureTenantVoiceInfra({ infra }, { ...INPUT, maxConcurrentCalls: 2.5 })
    ).rejects.toThrow(/positive integer/);
  });

  it("creates profile then app when none exist, searching by the marker", async () => {
    const infra = fakeInfra({});
    const result = await ensureTenantVoiceInfra({ infra }, INPUT);
    expect(infra.calls.findProfiles).toEqual([tenantInfraMarker(BIZ)]);
    expect(infra.calls.findApps).toEqual([tenantInfraMarker(BIZ)]);
    expect(infra.calls.createProfile![0]).toMatchObject({
      name: `Amy Laidlaw Real Estate ${tenantInfraMarker(BIZ)}`,
      concurrentCallLimit: 10,
      dailySpendLimitUsd: TENANT_PROFILE_DAILY_SPEND_LIMIT_USD,
      whitelistedDestinations: ["CA", "MX", "US"]
    });
    expect(infra.calls.createApp![0]).toMatchObject({
      webhookUrl: WEBHOOK,
      channelLimit: 10,
      outboundVoiceProfileId: "prof-new"
    });
    expect(result).toEqual({
      connectionId: "app-new",
      outboundVoiceProfileId: "prof-new",
      createdApp: true,
      createdProfile: true
    });
  });

  it("defaults the whitelist to the canonical country list and the fuse to $25", async () => {
    const infra = fakeInfra({});
    await ensureTenantVoiceInfra(
      { infra },
      { ...INPUT, whitelistedDestinations: undefined, dailySpendLimitUsd: undefined }
    );
    const createArgs = infra.calls.createProfile![0] as {
      whitelistedDestinations: string[];
      dailySpendLimitUsd: string;
    };
    for (const region of LIVE_TRAFFIC_REGIONS) {
      expect(createArgs.whitelistedDestinations).toContain(region);
    }
    expect(createArgs.whitelistedDestinations.length).toBeGreaterThan(50);
    expect(createArgs.dailySpendLimitUsd).toBe(TENANT_PROFILE_DAILY_SPEND_LIMIT_USD);
  });

  it("adopts a converged pair without a single PATCH", async () => {
    const infra = fakeInfra({ profiles: [adoptableProfile()], apps: [adoptableApp()] });
    const result = await ensureTenantVoiceInfra({ infra }, INPUT);
    expect(infra.calls.createProfile).toEqual([]);
    expect(infra.calls.createApp).toEqual([]);
    expect(infra.calls.patchProfile).toEqual([]);
    expect(infra.calls.patchApp).toEqual([]);
    expect(result).toEqual({
      connectionId: "app-old",
      outboundVoiceProfileId: "prof-old",
      createdApp: false,
      createdProfile: false
    });
  });

  it("converges a drifted profile limit and re-binds a drifted app", async () => {
    const infra = fakeInfra({
      profiles: [adoptableProfile({ concurrent_call_limit: 2 })],
      apps: [adoptableApp({ outbound: { channel_limit: 2, outbound_voice_profile_id: null } })]
    });
    await ensureTenantVoiceInfra({ infra }, INPUT);
    expect(infra.calls.patchProfile![0]).toMatchObject({ id: "prof-old", concurrentCallLimit: 10 });
    expect(infra.calls.patchApp![0]).toMatchObject({
      id: "app-old",
      channelLimit: 10,
      outboundVoiceProfileId: "prof-old",
      webhookUrl: WEBHOOK
    });
  });

  it("widens the whitelist as a union and NEVER narrows it", async () => {
    // The existing profile reaches GB; the desired list does not mention it.
    const infra = fakeInfra({
      profiles: [adoptableProfile({ whitelisted_destinations: ["CA", "GB", "US"] })],
      apps: [adoptableApp()]
    });
    await ensureTenantVoiceInfra({ infra }, INPUT);
    const patch = infra.calls.patchProfile![0] as { whitelistedDestinations: string[] };
    expect(patch.whitelistedDestinations).toEqual(["CA", "GB", "MX", "US"]);
  });

  it("re-points the DID onto the tenant app when asked", async () => {
    const infra = fakeInfra({ profiles: [adoptableProfile()], apps: [adoptableApp()] });
    const updates: unknown[] = [];
    const numbers = {
      updatePhoneNumber: async (opts: unknown) => {
        updates.push(opts);
        return {};
      }
    };
    await ensureTenantVoiceInfra({ infra, numbers }, { ...INPUT, didE164: "+16028053377" });
    expect(updates).toEqual([{ phoneNumberIdOrE164: "+16028053377", connectionId: "app-old" }]);
  });

  it("skips the DID re-point without a number or without a numbers client", async () => {
    const infra = fakeInfra({ profiles: [adoptableProfile()], apps: [adoptableApp()] });
    const updates: unknown[] = [];
    const numbers = {
      updatePhoneNumber: async (opts: unknown) => {
        updates.push(opts);
        return {};
      }
    };
    await ensureTenantVoiceInfra({ infra, numbers }, { ...INPUT, didE164: null });
    await ensureTenantVoiceInfra({ infra }, { ...INPUT, didE164: "+16028053377" });
    expect(updates).toEqual([]);
  });
});
