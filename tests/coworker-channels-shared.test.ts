import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two small shared pieces every team-chat channel leans on: the plan
 * gate and the worker kick.
 *
 * Both are tiny and both fail in a direction that matters. The gate decides
 * whether a paid feature acts at all, and the kick decides how quickly a
 * reply goes out; getting the kick's failure direction wrong would turn a
 * missing environment variable into a channel that silently never answers.
 */

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  coworkerChannelAllowedForBusiness,
  coworkerChannelAllowedForTier
} from "@/lib/coworker-channels/tier-gate";
import { kickCoworkerWorker } from "@/lib/coworker-channels/kick";

describe("the plan gate", () => {
  it.each([
    ["standard", true],
    ["enterprise", true],
    ["starter", false],
    ["free", false],
    [null, false],
    [undefined, false]
  ])("allows %s = %s", (tier, allowed) => {
    expect(coworkerChannelAllowedForTier(tier as string | null | undefined)).toBe(allowed);
  });

  it("resolves the tier from the business row", async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { tier: "enterprise" }, error: null }) })
        })
      })
    };
    expect(await coworkerChannelAllowedForBusiness("biz", db as never)).toBe(true);
  });

  it("throws on a read error rather than guessing a tier", async () => {
    // Each caller decides which way to fail: the connect route refuses, and
    // delivery catches this and delivers anyway. Swallowing it here would
    // take that choice away from both of them.
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "down" } }) })
        })
      })
    };
    await expect(coworkerChannelAllowedForBusiness("biz", db as never)).rejects.toThrow("down");
  });

  it("reaches for the service client when the caller passes none", async () => {
    defaultClientSpy.mockReturnValueOnce({
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { tier: "standard" }, error: null }) })
        })
      })
    });
    expect(await coworkerChannelAllowedForBusiness("biz")).toBe(true);
  });

  it("treats a business with no row as not allowed", async () => {
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) })
      })
    };
    expect(await coworkerChannelAllowedForBusiness("biz", db as never)).toBe(false);
  });
});

describe("the worker kick", () => {
  const env = { ...process.env };
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.INTERNAL_CRON_SECRET = "s3cret";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it("posts to the shared worker with the cron bearer and an Origin", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await kickCoworkerWorker("telegram");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.example.com/api/internal/coworker-worker");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer s3cret");
    // src/proxy.ts only allows a server-to-server bearer POST when Origin
    // matches; without this the kick is rejected and every reply waits for
    // the next sweep.
    expect(headers.Origin).toBe("https://app.example.com");
  });

  it("stays quiet when it is not configured, rather than throwing into a webhook", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.INTERNAL_CRON_SECRET;
    await expect(kickCoworkerWorker("telegram")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a failed kick: the sweep is the retry net", async () => {
    // A throw here would propagate into the webhook handler and turn a
    // stored message into a 500, which makes the provider redeliver a
    // message we already have.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      })
    );
    await expect(kickCoworkerWorker("slack")).resolves.toBeUndefined();
  });

  it("swallows a rejection that was not an Error either", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "connection reset";
      })
    );
    await expect(kickCoworkerWorker("telegram")).resolves.toBeUndefined();
  });
});
