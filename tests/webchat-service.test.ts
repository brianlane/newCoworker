import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StubResult = { data: unknown; error: { message: string } | null };

function makeBuilder(result: StubResult) {
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    maybeSingle: vi.fn(async () => result)
  };
  return b;
}

const supabaseStub = { from: vi.fn() };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => supabaseStub)
}));

vi.mock("@/lib/webchat/db", () => ({
  getWidgetSettingsByKeyHash: vi.fn(),
  getWebchatSessionByTokenHash: vi.fn()
}));

import {
  WEBCHAT_DAILY_MESSAGE_CAP_DEFAULT,
  WEBCHAT_SESSION_IDLE_TTL_MS,
  frameAncestorsValue,
  loadWebchatBusinessFlags,
  refererAllowedForFrame,
  resolveWidgetContext,
  sessionSatisfiesContactGate,
  verifyWebchatSession,
  webchatDailyMessageCap
} from "@/lib/webchat/service";
import {
  getWebchatSessionByTokenHash,
  getWidgetSettingsByKeyHash
} from "@/lib/webchat/db";
import { hashWebchatToken } from "@/lib/webchat/keys";

const BIZ = "11111111-1111-4111-8111-111111111111";
const KEY = `ncw_pub_${"a".repeat(64)}`;
const SESSION_TOKEN = `ncws_${"b".repeat(64)}`;

const settingsRow = {
  business_id: BIZ,
  enabled: true,
  public_key: KEY,
  public_key_sha256: hashWebchatToken(KEY),
  allowed_origins: [] as string[],
  require_contact_form: false,
  theme: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};

const bizRow = {
  id: BIZ,
  name: "Acme",
  tier: "standard",
  is_paused: false,
  customer_channels_enabled: true,
  timezone: "America/Phoenix"
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.WEBCHAT_DAILY_MESSAGE_CAP;
});

describe("webchatDailyMessageCap", () => {
  it("defaults, honors a valid env override, ignores garbage", () => {
    expect(webchatDailyMessageCap()).toBe(WEBCHAT_DAILY_MESSAGE_CAP_DEFAULT);
    process.env.WEBCHAT_DAILY_MESSAGE_CAP = "42.9";
    expect(webchatDailyMessageCap()).toBe(42);
    process.env.WEBCHAT_DAILY_MESSAGE_CAP = "-5";
    expect(webchatDailyMessageCap()).toBe(WEBCHAT_DAILY_MESSAGE_CAP_DEFAULT);
    process.env.WEBCHAT_DAILY_MESSAGE_CAP = "lots";
    expect(webchatDailyMessageCap()).toBe(WEBCHAT_DAILY_MESSAGE_CAP_DEFAULT);
  });
});

describe("loadWebchatBusinessFlags", () => {
  it("coerces the row shape defensively", async () => {
    supabaseStub.from.mockReturnValueOnce(
      makeBuilder({
        data: { id: BIZ, name: 7, tier: null, is_paused: 1, customer_channels_enabled: false, timezone: 9 },
        error: null
      })
    );
    expect(await loadWebchatBusinessFlags(BIZ)).toEqual({
      id: BIZ,
      name: "",
      tier: null,
      is_paused: true,
      customer_channels_enabled: false,
      timezone: null
    });
  });

  it("returns null for a missing row, throws on a read error, accepts a client", async () => {
    const client = { from: vi.fn(() => makeBuilder({ data: null, error: null })) };
    expect(await loadWebchatBusinessFlags(BIZ, client as never)).toBeNull();

    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: "x" } }));
    await expect(loadWebchatBusinessFlags(BIZ)).rejects.toThrow("loadWebchatBusinessFlags: x");
  });
});

describe("resolveWidgetContext", () => {
  const mockSettings = vi.mocked(getWidgetSettingsByKeyHash);

  function mockBusiness(row: Record<string, unknown> | null) {
    supabaseStub.from.mockReturnValueOnce(makeBuilder({ data: row, error: null }));
  }

  it("rejects malformed and unknown keys", async () => {
    expect(await resolveWidgetContext({ key: "garbage" })).toEqual({
      ok: false,
      reason: "invalid_key"
    });
    expect(mockSettings).not.toHaveBeenCalled();

    mockSettings.mockResolvedValueOnce(null);
    expect(await resolveWidgetContext({ key: KEY })).toEqual({ ok: false, reason: "invalid_key" });
    expect(mockSettings).toHaveBeenCalledWith(hashWebchatToken(KEY), supabaseStub);
  });

  it("rejects a disabled widget", async () => {
    mockSettings.mockResolvedValueOnce({ ...settingsRow, enabled: false });
    expect(await resolveWidgetContext({ key: KEY })).toEqual({
      ok: false,
      reason: "widget_disabled"
    });
  });

  it("treats a vanished business as invalid_key", async () => {
    mockSettings.mockResolvedValueOnce(settingsRow);
    mockBusiness(null);
    expect(await resolveWidgetContext({ key: KEY })).toEqual({ ok: false, reason: "invalid_key" });
  });

  it("disables server-side when the tier dropped below Standard", async () => {
    mockSettings.mockResolvedValueOnce(settingsRow);
    mockBusiness({ ...bizRow, tier: "starter" });
    expect(await resolveWidgetContext({ key: KEY })).toEqual({
      ok: false,
      reason: "widget_disabled"
    });
  });

  it("goes offline for paused and Safe Mode tenants", async () => {
    mockSettings.mockResolvedValueOnce(settingsRow);
    mockBusiness({ ...bizRow, is_paused: true });
    expect(await resolveWidgetContext({ key: KEY })).toEqual({ ok: false, reason: "offline" });

    mockSettings.mockResolvedValueOnce(settingsRow);
    mockBusiness({ ...bizRow, customer_channels_enabled: false });
    expect(await resolveWidgetContext({ key: KEY })).toEqual({ ok: false, reason: "offline" });
  });

  it("succeeds for an enabled Standard tenant (and accepts an injected client)", async () => {
    mockSettings.mockResolvedValueOnce(settingsRow);
    const client = { from: vi.fn(() => makeBuilder({ data: bizRow, error: null })) };
    const out = await resolveWidgetContext({ key: KEY, client: client as never });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.settings).toEqual(settingsRow);
      expect(out.business.id).toBe(BIZ);
      expect(out.business.timezone).toBe("America/Phoenix");
    }
    expect(mockSettings).toHaveBeenCalledWith(hashWebchatToken(KEY), client);
  });
});

describe("verifyWebchatSession", () => {
  const mockSession = vi.mocked(getWebchatSessionByTokenHash);
  const NOW = new Date("2026-07-10T12:00:00Z");

  const sessionRow = {
    id: "22222222-2222-4222-8222-222222222222",
    business_id: BIZ,
    session_token_sha256: hashWebchatToken(SESSION_TOKEN),
    visitor_name: null,
    visitor_email: null,
    visitor_phone: null,
    rowboat_conversation_id: null,
    rowboat_state: null,
    last_seen_at: new Date(NOW.getTime() - 60_000).toISOString(),
    created_at: "2026-07-10T00:00:00Z"
  };

  it("rejects malformed headers without a DB read", async () => {
    expect(
      await verifyWebchatSession({ authorizationHeader: null, businessId: BIZ })
    ).toBeNull();
    expect(
      await verifyWebchatSession({ authorizationHeader: "Bearer junk", businessId: BIZ })
    ).toBeNull();
    expect(mockSession).not.toHaveBeenCalled();
  });

  it("rejects unknown tokens and cross-tenant sessions", async () => {
    mockSession.mockResolvedValueOnce(null);
    expect(
      await verifyWebchatSession({
        authorizationHeader: `Bearer ${SESSION_TOKEN}`,
        businessId: BIZ,
        now: NOW
      })
    ).toBeNull();

    mockSession.mockResolvedValueOnce({ ...sessionRow, business_id: "other" });
    expect(
      await verifyWebchatSession({
        authorizationHeader: `Bearer ${SESSION_TOKEN}`,
        businessId: BIZ,
        now: NOW
      })
    ).toBeNull();
  });

  it("rejects idle-expired and garbage-timestamp sessions", async () => {
    mockSession.mockResolvedValueOnce({
      ...sessionRow,
      last_seen_at: new Date(NOW.getTime() - WEBCHAT_SESSION_IDLE_TTL_MS - 1000).toISOString()
    });
    expect(
      await verifyWebchatSession({
        authorizationHeader: `Bearer ${SESSION_TOKEN}`,
        businessId: BIZ,
        now: NOW
      })
    ).toBeNull();

    mockSession.mockResolvedValueOnce({ ...sessionRow, last_seen_at: "not a date" });
    expect(
      await verifyWebchatSession({
        authorizationHeader: `Bearer ${SESSION_TOKEN}`,
        businessId: BIZ,
        now: NOW
      })
    ).toBeNull();
  });

  it("returns the live session row (default now)", async () => {
    const fresh = { ...sessionRow, last_seen_at: new Date().toISOString() };
    mockSession.mockResolvedValueOnce(fresh);
    expect(
      await verifyWebchatSession({
        authorizationHeader: `Bearer ${SESSION_TOKEN}`,
        businessId: BIZ
      })
    ).toEqual(fresh);
    expect(mockSession).toHaveBeenCalledWith(hashWebchatToken(SESSION_TOKEN), undefined);
  });
});

describe("sessionSatisfiesContactGate", () => {
  const on = { require_contact_form: true };
  const off = { require_contact_form: false };
  const empty = { visitor_name: null, visitor_email: null, visitor_phone: null };

  it("always passes when the form requirement is off", () => {
    expect(sessionSatisfiesContactGate(off, empty)).toBe(true);
  });

  it("requires a name plus at least one of email/phone when on", () => {
    expect(sessionSatisfiesContactGate(on, empty)).toBe(false);
    expect(sessionSatisfiesContactGate(on, { ...empty, visitor_name: "Ada" })).toBe(false);
    expect(
      sessionSatisfiesContactGate(on, { ...empty, visitor_email: "a@b.com" })
    ).toBe(false);
    expect(
      sessionSatisfiesContactGate(on, { visitor_name: "Ada", visitor_email: "a@b.com", visitor_phone: null })
    ).toBe(true);
    expect(
      sessionSatisfiesContactGate(on, { visitor_name: "Ada", visitor_email: null, visitor_phone: "+1555" })
    ).toBe(true);
    // Whitespace-only values don't count.
    expect(
      sessionSatisfiesContactGate(on, { visitor_name: "  ", visitor_email: "a@b.com", visitor_phone: null })
    ).toBe(false);
  });
});

describe("frameAncestorsValue", () => {
  it("is * for an empty or all-invalid list", () => {
    expect(frameAncestorsValue([])).toBe("*");
    expect(frameAncestorsValue(["ftp://junk"])).toBe("*");
  });

  it("emits both www and bare twins, deduped, with ports preserved", () => {
    expect(frameAncestorsValue(["https://example.com"])).toBe(
      "https://example.com https://www.example.com"
    );
    // www entry collapses to the same pair — no duplicates.
    expect(frameAncestorsValue(["https://www.example.com", "https://example.com"])).toBe(
      "https://example.com https://www.example.com"
    );
    expect(frameAncestorsValue(["http://localhost:3000"])).toBe(
      "http://localhost:3000 http://www.localhost:3000"
    );
  });
});

describe("refererAllowedForFrame", () => {
  const allowed = ["https://example.com"];

  it("allows everything on an empty allowlist", () => {
    expect(refererAllowedForFrame("https://evil.com/", [])).toBe(true);
  });

  it("allows absent or unparseable referers (CSP is the hard gate)", () => {
    expect(refererAllowedForFrame(null, allowed)).toBe(true);
    expect(refererAllowedForFrame("   ", allowed)).toBe(true);
    expect(refererAllowedForFrame("ftp://x", allowed)).toBe(true);
  });

  it("enforces the list when a real origin is present", () => {
    expect(refererAllowedForFrame("https://example.com/some/page", allowed)).toBe(true);
    expect(refererAllowedForFrame("https://www.example.com/", allowed)).toBe(true);
    expect(refererAllowedForFrame("https://evil.com/page", allowed)).toBe(false);
  });
});
