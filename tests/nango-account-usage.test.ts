import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockListConnections = vi.fn();
const mockRateLimitDurable = vi.fn();
const mockSendOpsNangoQuotaEmail = vi.fn();

vi.mock("@/lib/nango/server", () => ({
  getNangoClient: () => ({ listConnections: mockListConnections })
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimitDurable: (...a: unknown[]) => mockRateLimitDurable(...a)
}));

vi.mock("@/lib/email/ops-notify", () => ({
  sendOpsNangoQuotaEmail: (...a: unknown[]) => mockSendOpsNangoQuotaEmail(...a)
}));

import {
  DEFAULT_NANGO_ACCOUNT_CONNECTION_LIMIT,
  getNangoAccountUsage,
  maybeSendNangoQuotaAlert,
  nangoAccountConnectionLimit
} from "@/lib/nango/account-usage";

const OLD_ENV = process.env;

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...OLD_ENV, NANGO_SECRET_KEY: "sk" };
  delete process.env.NANGO_ACCOUNT_CONNECTION_LIMIT;
});

afterEach(() => {
  process.env = OLD_ENV;
});

function connections(n: number) {
  return { connections: Array.from({ length: n }, (_, i) => ({ connection_id: `c${i}` })) };
}

describe("nangoAccountConnectionLimit", () => {
  it("defaults to the free-plan limit of 10", () => {
    expect(nangoAccountConnectionLimit()).toBe(DEFAULT_NANGO_ACCOUNT_CONNECTION_LIMIT);
    expect(DEFAULT_NANGO_ACCOUNT_CONNECTION_LIMIT).toBe(10);
  });

  it("honors a positive NANGO_ACCOUNT_CONNECTION_LIMIT override", () => {
    process.env.NANGO_ACCOUNT_CONNECTION_LIMIT = "20";
    expect(nangoAccountConnectionLimit()).toBe(20);
  });

  it("ignores junk / non-positive overrides", () => {
    process.env.NANGO_ACCOUNT_CONNECTION_LIMIT = "banana";
    expect(nangoAccountConnectionLimit()).toBe(10);
    process.env.NANGO_ACCOUNT_CONNECTION_LIMIT = "0";
    expect(nangoAccountConnectionLimit()).toBe(10);
  });
});

describe("getNangoAccountUsage", () => {
  it("returns null without NANGO_SECRET_KEY", async () => {
    delete process.env.NANGO_SECRET_KEY;
    await expect(getNangoAccountUsage()).resolves.toBeNull();
    expect(mockListConnections).not.toHaveBeenCalled();
  });

  it("counts connections and flags nearLimit at >= 80% of the limit", async () => {
    mockListConnections.mockResolvedValue(connections(7));
    await expect(getNangoAccountUsage()).resolves.toEqual({
      used: 7,
      limit: 10,
      nearLimit: false
    });

    mockListConnections.mockResolvedValue(connections(8));
    await expect(getNangoAccountUsage()).resolves.toEqual({
      used: 8,
      limit: 10,
      nearLimit: true
    });
    expect(mockListConnections).toHaveBeenCalledWith({ limit: 1000 });
  });

  it("returns null on an unexpected response shape", async () => {
    mockListConnections.mockResolvedValue({ nope: true });
    await expect(getNangoAccountUsage()).resolves.toBeNull();
    mockListConnections.mockResolvedValue(null);
    await expect(getNangoAccountUsage()).resolves.toBeNull();
  });

  it("returns null when the Nango API throws", async () => {
    mockListConnections.mockRejectedValue(new Error("401"));
    await expect(getNangoAccountUsage()).resolves.toBeNull();
  });
});

describe("maybeSendNangoQuotaAlert", () => {
  it("does nothing when usage is unreadable or has headroom", async () => {
    mockListConnections.mockRejectedValue(new Error("down"));
    await maybeSendNangoQuotaAlert();

    mockListConnections.mockResolvedValue(connections(3));
    await maybeSendNangoQuotaAlert();

    expect(mockRateLimitDurable).not.toHaveBeenCalled();
    expect(mockSendOpsNangoQuotaEmail).not.toHaveBeenCalled();
  });

  it("sends the ops email once per 24h window when near the limit", async () => {
    mockListConnections.mockResolvedValue(connections(9));
    mockRateLimitDurable.mockResolvedValue({ success: true });
    mockSendOpsNangoQuotaEmail.mockResolvedValue(true);

    await maybeSendNangoQuotaAlert();

    expect(mockRateLimitDurable).toHaveBeenCalledWith("ops:nango-quota-alert", {
      interval: 24 * 60 * 60 * 1000,
      maxRequests: 1
    });
    expect(mockSendOpsNangoQuotaEmail).toHaveBeenCalledWith({ used: 9, limit: 10 });
  });

  it("skips the email when the dedupe window already fired", async () => {
    mockListConnections.mockResolvedValue(connections(9));
    mockRateLimitDurable.mockResolvedValue({ success: false });

    await maybeSendNangoQuotaAlert();
    expect(mockSendOpsNangoQuotaEmail).not.toHaveBeenCalled();
  });

  it("never throws — a limiter failure is swallowed", async () => {
    mockListConnections.mockResolvedValue(connections(10));
    mockRateLimitDurable.mockRejectedValue(new Error("rpc down"));

    await expect(maybeSendNangoQuotaAlert()).resolves.toBeUndefined();
    expect(mockSendOpsNangoQuotaEmail).not.toHaveBeenCalled();
  });
});
