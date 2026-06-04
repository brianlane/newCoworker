import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  OWNER_CHAT_SPEND_CAP_MICROS,
  OWNER_CHAT_AGENT_GEMINI,
  OWNER_CHAT_AGENT_LOCAL,
  getOwnerChatPeriodStart,
  getOwnerChatSpendMicros,
  chooseOwnerChatStartAgent
} from "@/lib/db/owner-chat-spend";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function chain(): Chain {
  const c: Chain = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    order: vi.fn(() => c),
    limit: vi.fn(() => c),
    maybeSingle: vi.fn()
  };
  return c;
}

function makeDb(c: Chain) {
  return { from: vi.fn(() => c) };
}

const BIZ = "11111111-1111-4111-8111-111111111111";
const PERIOD = "2026-06-01T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOwnerChatPeriodStart", () => {
  it("returns the subscription's current Stripe period start", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { stripe_current_period_start: PERIOD }, error: null });
    const out = await getOwnerChatPeriodStart(BIZ, makeDb(c) as never);
    expect(out).toBe(PERIOD);
  });

  it("falls back to the start of the current UTC month when there is no subscription", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    const out = await getOwnerChatPeriodStart(BIZ, makeDb(c) as never);
    const d = new Date(out);
    expect(d.getUTCDate()).toBe(1);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCFullYear()).toBe(new Date().getUTCFullYear());
    expect(d.getUTCMonth()).toBe(new Date().getUTCMonth());
  });
});

describe("getOwnerChatSpendMicros", () => {
  it("returns the stored spend for the period", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { spend_micros: 1234 }, error: null });
    const out = await getOwnerChatSpendMicros(BIZ, PERIOD, makeDb(c) as never);
    expect(out).toBe(1234);
  });

  it("returns 0 when no row exists yet (fresh period)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    const out = await getOwnerChatSpendMicros(BIZ, PERIOD, makeDb(c) as never);
    expect(out).toBe(0);
  });
});

describe("chooseOwnerChatStartAgent", () => {
  it("routes to the Gemini agent when period spend is below the cap", async () => {
    const c = chain();
    c.maybeSingle
      .mockResolvedValueOnce({ data: { stripe_current_period_start: PERIOD }, error: null })
      .mockResolvedValueOnce({ data: { spend_micros: OWNER_CHAT_SPEND_CAP_MICROS - 1 }, error: null });
    const out = await chooseOwnerChatStartAgent(BIZ, makeDb(c) as never);
    expect(out.startAgent).toBe(OWNER_CHAT_AGENT_GEMINI);
    expect(out.capReached).toBe(false);
    expect(out.periodStart).toBe(PERIOD);
  });

  it("routes to the local Qwen agent once spend reaches the cap", async () => {
    const c = chain();
    c.maybeSingle
      .mockResolvedValueOnce({ data: { stripe_current_period_start: PERIOD }, error: null })
      .mockResolvedValueOnce({ data: { spend_micros: OWNER_CHAT_SPEND_CAP_MICROS }, error: null });
    const out = await chooseOwnerChatStartAgent(BIZ, makeDb(c) as never);
    expect(out.startAgent).toBe(OWNER_CHAT_AGENT_LOCAL);
    expect(out.capReached).toBe(true);
  });

  it("fails OPEN to the Gemini agent on a read error (quality over fuse on transient DB failure)", async () => {
    const c = chain();
    c.maybeSingle.mockRejectedValue(new Error("db down"));
    const out = await chooseOwnerChatStartAgent(BIZ, makeDb(c) as never);
    expect(out.startAgent).toBe(OWNER_CHAT_AGENT_GEMINI);
    expect(out.capReached).toBe(false);
  });
});

describe("default service client (no explicit client passed)", () => {
  it("getOwnerChatPeriodStart constructs the service client when none is given", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { stripe_current_period_start: PERIOD }, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    const out = await getOwnerChatPeriodStart(BIZ);
    expect(out).toBe(PERIOD);
    expect(defaultClientSpy).toHaveBeenCalled();
  });

  it("getOwnerChatSpendMicros constructs the service client when none is given", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { spend_micros: 42 }, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    const out = await getOwnerChatSpendMicros(BIZ, PERIOD);
    expect(out).toBe(42);
    expect(defaultClientSpy).toHaveBeenCalled();
  });

  it("chooseOwnerChatStartAgent constructs the service client when none is given", async () => {
    const c = chain();
    c.maybeSingle
      .mockResolvedValueOnce({ data: { stripe_current_period_start: PERIOD }, error: null })
      .mockResolvedValueOnce({ data: { spend_micros: 0 }, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    const out = await chooseOwnerChatStartAgent(BIZ);
    expect(out.startAgent).toBe(OWNER_CHAT_AGENT_GEMINI);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});
