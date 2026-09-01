import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchTelnyxAutoRechargePrefs,
  fetchTelnyxBalance,
  formatAutoRechargeLine
} from "@/lib/telnyx/balance";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTelnyxBalance", () => {
  it("returns the parsed balance with pending and currency", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { balance: "312.45", pending: "12.30", currency: "USD" } })
    );
    await expect(fetchTelnyxBalance("tk", fetchImpl)).resolves.toEqual({
      balanceUsd: 312.45,
      pendingUsd: 12.3,
      currency: "USD"
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/balance",
      expect.objectContaining({ headers: { Authorization: "Bearer tk" } })
    );
  });

  it("defaults missing pending to null and missing currency to USD", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { balance: 100 } }));
    await expect(fetchTelnyxBalance("tk", fetchImpl)).resolves.toEqual({
      balanceUsd: 100,
      pendingUsd: null,
      currency: "USD"
    });
  });

  it("returns null without a key, on HTTP errors, on unusable balances, and on thrown fetches", async () => {
    await expect(fetchTelnyxBalance(null)).resolves.toBeNull();
    await expect(fetchTelnyxBalance("")).resolves.toBeNull();

    const notOk = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(fetchTelnyxBalance("tk", notOk)).resolves.toBeNull();

    const badBody = vi.fn(async () => jsonResponse({ data: { balance: "junk" } }));
    await expect(fetchTelnyxBalance("tk", badBody)).resolves.toBeNull();

    const noData = vi.fn(async () => jsonResponse({}));
    await expect(fetchTelnyxBalance("tk", noData)).resolves.toBeNull();

    const throws = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(fetchTelnyxBalance("tk", throws)).resolves.toBeNull();
  });

  it("uses global fetch by default", async () => {
    const stub = vi.fn(async () => jsonResponse({ data: { balance: "5.00" } }));
    vi.stubGlobal("fetch", stub);
    await expect(fetchTelnyxBalance("tk")).resolves.toMatchObject({ balanceUsd: 5 });
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

describe("fetchTelnyxAutoRechargePrefs", () => {
  it("returns the parsed threshold, recharge, enabled flag, and preference", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          enabled: true,
          threshold_amount: "2.00",
          recharge_amount: "28.00",
          preference: "credit_paypal"
        }
      })
    );
    await expect(fetchTelnyxAutoRechargePrefs("tk", fetchImpl)).resolves.toEqual({
      enabled: true,
      thresholdUsd: 2,
      rechargeUsd: 28,
      preference: "credit_paypal"
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/payment/auto_recharge_prefs",
      expect.objectContaining({ headers: { Authorization: "Bearer tk" } })
    );
  });

  it("treats a missing enabled flag as off and a missing preference as null", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { threshold_amount: 2, recharge_amount: 28 } })
    );
    await expect(fetchTelnyxAutoRechargePrefs("tk", fetchImpl)).resolves.toEqual({
      enabled: false,
      thresholdUsd: 2,
      rechargeUsd: 28,
      preference: null
    });
  });

  it("returns null without a key, on HTTP errors, on unusable amounts, and on thrown fetches", async () => {
    await expect(fetchTelnyxAutoRechargePrefs(null)).resolves.toBeNull();
    await expect(fetchTelnyxAutoRechargePrefs("")).resolves.toBeNull();

    const notOk = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(fetchTelnyxAutoRechargePrefs("tk", notOk)).resolves.toBeNull();

    const badBody = vi.fn(async () =>
      jsonResponse({ data: { enabled: true, threshold_amount: "junk", recharge_amount: "28" } })
    );
    await expect(fetchTelnyxAutoRechargePrefs("tk", badBody)).resolves.toBeNull();

    const noData = vi.fn(async () => jsonResponse({}));
    await expect(fetchTelnyxAutoRechargePrefs("tk", noData)).resolves.toBeNull();

    const throws = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(fetchTelnyxAutoRechargePrefs("tk", throws)).resolves.toBeNull();
  });

  it("uses global fetch by default", async () => {
    const stub = vi.fn(async () =>
      jsonResponse({
        data: { enabled: true, threshold_amount: "2", recharge_amount: "28" }
      })
    );
    vi.stubGlobal("fetch", stub);
    await expect(fetchTelnyxAutoRechargePrefs("tk")).resolves.toMatchObject({
      thresholdUsd: 2,
      rechargeUsd: 28
    });
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

describe("formatAutoRechargeLine", () => {
  it("names the PayPal bucket when auto-recharge is on", () => {
    expect(
      formatAutoRechargeLine({
        enabled: true,
        thresholdUsd: 2,
        rechargeUsd: 28,
        preference: "credit_paypal"
      })
    ).toBe("auto-recharge $28.00 when below $2.00 via PayPal");
  });

  it("names a card preference and omits an unknown one", () => {
    expect(
      formatAutoRechargeLine({
        enabled: true,
        thresholdUsd: 2,
        rechargeUsd: 28,
        preference: "credit_card"
      })
    ).toBe("auto-recharge $28.00 when below $2.00 via card");
    expect(
      formatAutoRechargeLine({
        enabled: true,
        thresholdUsd: 5,
        rechargeUsd: 50,
        preference: null
      })
    ).toBe("auto-recharge $50.00 when below $5.00");
  });

  it("says off when disabled, even if amounts are set", () => {
    expect(
      formatAutoRechargeLine({
        enabled: false,
        thresholdUsd: 2,
        rechargeUsd: 28,
        preference: "credit_paypal"
      })
    ).toBe("auto-recharge off");
  });
});
