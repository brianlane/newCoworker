import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchTelnyxBalance } from "@/lib/telnyx/balance";

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
