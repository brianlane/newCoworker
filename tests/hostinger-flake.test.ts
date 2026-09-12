import { describe, expect, it, vi } from "vitest";
import { HostingerApiError } from "@/lib/hostinger/client";
import {
  HOSTINGER_FLAKE_WINDOW_MINUTES,
  hostingerFlakeDetail,
  isHostingerFlakeError,
  isHostingerFlakeMessage,
  isHostingerListFlakeMessage,
  retryOnceOnHostingerFlake
} from "@/lib/hostinger/flake";
import { TRANSIENT_FINDING_WINDOW_MINUTES } from "@/lib/vps/billing-posture";

function catalogTimeout(): HostingerApiError {
  return new HostingerApiError(
    "/api/billing/v1/catalog?category=VPS",
    0,
    null,
    "Hostinger API /api/billing/v1/catalog?category=VPS timed out after 30000ms"
  );
}

describe("isHostingerFlakeMessage", () => {
  it("matches a catalog timeout", () => {
    expect(
      isHostingerFlakeMessage("Hostinger API /api/billing/v1/catalog?category=VPS timed out after 30000ms")
    ).toBe(true);
  });

  it("matches a network drop", () => {
    expect(isHostingerFlakeMessage("Hostinger API /api/billing/v1/catalog network error: fetch failed")).toBe(
      true
    );
  });

  it("still matches when the ledger wrapped the message in JSON", () => {
    expect(
      isHostingerFlakeMessage(
        '{"code":"INTERNAL_SERVER_ERROR","message":"Hostinger API /x timed out after 30000ms"}'
      )
    ).toBe(true);
  });

  it("does not match a hard miss", () => {
    expect(isHostingerFlakeMessage("Hostinger API /virtual-machines/1 → HTTP 404")).toBe(false);
  });
});

describe("isHostingerListFlakeMessage", () => {
  it("matches a catalog timeout, including the query string", () => {
    expect(
      isHostingerListFlakeMessage(
        "Hostinger API /api/billing/v1/catalog?category=VPS timed out after 30000ms"
      )
    ).toBe(true);
  });

  it("matches a catalog network drop without a query string", () => {
    expect(
      isHostingerListFlakeMessage("Hostinger API /api/billing/v1/catalog network error: fetch failed")
    ).toBe(true);
  });

  it("matches a billing-list timeout", () => {
    expect(
      isHostingerListFlakeMessage("Hostinger API /api/billing/v1/subscriptions timed out after 30000ms")
    ).toBe(true);
  });

  it("matches the route's failures[] prefix", () => {
    expect(
      isHostingerListFlakeMessage(
        "Hostinger list failed: Hostinger API /api/billing/v1/catalog?category=VPS timed out after 30000ms"
      )
    ).toBe(true);
  });

  it("does not match a purchase timeout: a box may already have been bought", () => {
    expect(
      isHostingerListFlakeMessage("Hostinger API /api/vps/v1/virtual-machines timed out after 30000ms")
    ).toBe(false);
  });

  it("does not match an auto-renewal timeout on one subscription", () => {
    expect(
      isHostingerListFlakeMessage(
        "Hostinger API /api/billing/v1/subscriptions/abc/auto-renewal/disable timed out after 30000ms"
      )
    ).toBe(false);
  });
});

describe("isHostingerFlakeError", () => {
  it("accepts a HostingerApiError timeout", () => {
    expect(isHostingerFlakeError(catalogTimeout())).toBe(true);
  });

  it("accepts a HostingerApiError whose message omitted the prefix", () => {
    const err = new HostingerApiError("/x", 0, null, "timed out after 30000ms");
    expect(isHostingerFlakeError(err)).toBe(true);
  });

  it("accepts a plain string that still names the Hostinger API", () => {
    expect(isHostingerFlakeError("Hostinger API /x timed out after 1ms")).toBe(true);
  });

  it("rejects a timeout that is not a Hostinger call", () => {
    expect(isHostingerFlakeError(new Error("timed out after 30000ms"))).toBe(false);
  });

  it("rejects a Hostinger HTTP 404", () => {
    expect(isHostingerFlakeError(new HostingerApiError("/x", 404, {}, "Hostinger API /x → HTTP 404"))).toBe(
      false
    );
  });
});

describe("hostingerFlakeDetail", () => {
  it("stringifies a non-Error throw", () => {
    expect(hostingerFlakeDetail("Hostinger API /x timed out after 1ms")).toBe(
      "Hostinger API /x timed out after 1ms"
    );
  });
});

describe("retryOnceOnHostingerFlake", () => {
  it("returns the first success without a second call", async () => {
    const fn = vi.fn(async () => 7);
    await expect(retryOnceOnHostingerFlake(fn)).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries once after a timeout and then succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(catalogTimeout()).mockResolvedValueOnce(3);
    await expect(retryOnceOnHostingerFlake(fn)).resolves.toBe(3);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws the second flake rather than inventing success", async () => {
    const fn = vi.fn(async () => {
      throw catalogTimeout();
    });
    await expect(retryOnceOnHostingerFlake(fn)).rejects.toThrow(/timed out after 30000ms/);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-flake", async () => {
    const fn = vi.fn(async () => {
      throw new Error("HTTP 500");
    });
    await expect(retryOnceOnHostingerFlake(fn)).rejects.toThrow("HTTP 500");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("HOSTINGER_FLAKE_WINDOW_MINUTES", () => {
  it("matches the billing-posture 48h window, so two daily crons can see each other", () => {
    expect(HOSTINGER_FLAKE_WINDOW_MINUTES).toBe(48 * 60);
    expect(TRANSIENT_FINDING_WINDOW_MINUTES).toBe(HOSTINGER_FLAKE_WINDOW_MINUTES);
  });
});
