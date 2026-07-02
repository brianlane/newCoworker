import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAuthUserMock,
  listBusinessIdsByOwnerEmailMock,
  findCheckoutBlockingSubscriptionMock,
  loggerWarnMock
} = vi.hoisted(() => ({
  getAuthUserMock: vi.fn(),
  listBusinessIdsByOwnerEmailMock: vi.fn(),
  findCheckoutBlockingSubscriptionMock: vi.fn(),
  loggerWarnMock: vi.fn()
}));

vi.mock("@/lib/auth", () => ({
  getAuthUser: getAuthUserMock
}));

vi.mock("@/lib/db/businesses", () => ({
  listBusinessIdsByOwnerEmail: listBusinessIdsByOwnerEmailMock
}));

vi.mock("@/lib/db/subscriptions", () => ({
  findCheckoutBlockingSubscription: findCheckoutBlockingSubscriptionMock
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
    debug: vi.fn()
  }
}));

import { hasActiveSubscriptionForCurrentUser } from "@/lib/onboarding/active-subscriber-guard";

describe("hasActiveSubscriptionForCurrentUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthUserMock.mockResolvedValue({ userId: "user_1", email: "owner@example.com" });
    listBusinessIdsByOwnerEmailMock.mockResolvedValue(["biz-1", "biz-2"]);
    findCheckoutBlockingSubscriptionMock.mockResolvedValue(null);
  });

  it("returns false for anonymous visitors", async () => {
    getAuthUserMock.mockResolvedValue(null);
    await expect(hasActiveSubscriptionForCurrentUser()).resolves.toBe(false);
    expect(listBusinessIdsByOwnerEmailMock).not.toHaveBeenCalled();
  });

  it("returns false when the auth user has no email", async () => {
    getAuthUserMock.mockResolvedValue({ userId: "user_1", email: null });
    await expect(hasActiveSubscriptionForCurrentUser()).resolves.toBe(false);
    expect(listBusinessIdsByOwnerEmailMock).not.toHaveBeenCalled();
  });

  it("returns false when the user owns no businesses", async () => {
    listBusinessIdsByOwnerEmailMock.mockResolvedValue([]);
    await expect(hasActiveSubscriptionForCurrentUser()).resolves.toBe(false);
    expect(findCheckoutBlockingSubscriptionMock).not.toHaveBeenCalled();
  });

  it("returns true when any owned business has a blocking subscription", async () => {
    findCheckoutBlockingSubscriptionMock.mockResolvedValue({ id: "sub-live", status: "active" });
    await expect(hasActiveSubscriptionForCurrentUser()).resolves.toBe(true);
    expect(listBusinessIdsByOwnerEmailMock).toHaveBeenCalledWith("owner@example.com");
    expect(findCheckoutBlockingSubscriptionMock).toHaveBeenCalledWith(["biz-1", "biz-2"]);
  });

  it("returns false when no blocking subscription exists", async () => {
    await expect(hasActiveSubscriptionForCurrentUser()).resolves.toBe(false);
  });

  it("fails open (false) and warns when the DB read throws", async () => {
    listBusinessIdsByOwnerEmailMock.mockRejectedValue(new Error("replica timeout"));
    await expect(hasActiveSubscriptionForCurrentUser()).resolves.toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "onboarding active-subscriber guard read failed; failing open",
      expect.objectContaining({ error: "replica timeout" })
    );
  });

  it("fails open on non-Error throws too", async () => {
    findCheckoutBlockingSubscriptionMock.mockRejectedValue("string failure");
    await expect(hasActiveSubscriptionForCurrentUser()).resolves.toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "onboarding active-subscriber guard read failed; failing open",
      expect.objectContaining({ error: "string failure" })
    );
  });
});
