import { describe, expect, it, vi } from "vitest";
import { HostingerApiError } from "@/lib/hostinger/client";
import {
  hostingerListFlakeLogEvent,
  applyHostingerListFlakePaging,
  loadHostingerListsForSweep
} from "@/lib/vps/hostinger-list-load";
import { HOSTINGER_FLAKE_WINDOW_MINUTES } from "@/lib/hostinger/flake";
import type { recordFailure } from "@/lib/db/system-logs";

function catalogTimeout(): HostingerApiError {
  return new HostingerApiError(
    "/api/billing/v1/catalog?category=VPS",
    0,
    null,
    "Hostinger API /api/billing/v1/catalog?category=VPS timed out after 30000ms"
  );
}

describe("loadHostingerListsForSweep", () => {
  it("retries a catalog timeout and then continues", async () => {
    const listCatalog = vi
      .fn()
      .mockRejectedValueOnce(catalogTimeout())
      .mockResolvedValueOnce([]);
    const listBillingSubscriptions = vi.fn(async () => []);
    const loaded = await loadHostingerListsForSweep({ listCatalog, listBillingSubscriptions });
    expect(loaded).toEqual({ ok: true, lists: { catalog: [], billingSubs: [] } });
    expect(listCatalog).toHaveBeenCalledTimes(2);
    expect(listBillingSubscriptions).toHaveBeenCalledTimes(2);
  });

  it("returns a detail after two flakes instead of throwing", async () => {
    const listCatalog = vi.fn(async () => {
      throw catalogTimeout();
    });
    const loaded = await loadHostingerListsForSweep({
      listCatalog,
      listBillingSubscriptions: vi.fn(async () => [])
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("expected flake detail");
    expect(loaded.detail).toContain("timed out after 30000ms");
    expect(listCatalog).toHaveBeenCalledTimes(2);
  });

  it("rethrows a non-flake so a real Hostinger bug still fails loud", async () => {
    await expect(
      loadHostingerListsForSweep({
        listCatalog: vi.fn(async () => {
          throw new Error("catalog 500");
        }),
        listBillingSubscriptions: vi.fn(async () => [])
      })
    ).rejects.toThrow("catalog 500");
  });
});

describe("applyHostingerListFlakePaging", () => {
  const sweep = "vps-contract-upgrade-sweep";
  const detail = "Hostinger API /api/billing/v1/catalog?category=VPS timed out after 30000ms";

  it("leaves a clean result alone", async () => {
    const recorder = vi.fn() as unknown as typeof recordFailure;
    const result = await applyHostingerListFlakePaging(
      { failures: [], hostingerUnavailable: undefined },
      sweep,
      recorder
    );
    expect(result).toEqual({ failures: [], hostingerUnavailable: undefined });
    expect(recorder).not.toHaveBeenCalled();
  });

  it("holds the first flake off failures[]", async () => {
    const recorder = vi.fn(async () => "warn") as unknown as typeof recordFailure;
    const result = await applyHostingerListFlakePaging(
      { failures: [], hostingerUnavailable: detail },
      sweep,
      recorder
    );
    expect(result.failures).toEqual([]);
    expect(recorder).toHaveBeenCalledWith(
      {
        businessId: null,
        source: sweep,
        event: hostingerListFlakeLogEvent(sweep),
        message: detail
      },
      { windowMinutes: HOSTINGER_FLAKE_WINDOW_MINUTES }
    );
  });

  it("copies a repeat flake into failures[] so the watchdog sees a partial failure, not a crash", async () => {
    const recorder = vi.fn(async () => "error") as unknown as typeof recordFailure;
    const result = await applyHostingerListFlakePaging(
      { failures: [], hostingerUnavailable: detail },
      sweep,
      recorder
    );
    expect(result.failures).toEqual([`Hostinger list failed: ${detail}`]);
  });

  it("fails loud when the recorder throws, matching recordFailure", async () => {
    const recorder = vi.fn(async () => {
      throw new Error("system_logs down");
    }) as unknown as typeof recordFailure;
    const result = await applyHostingerListFlakePaging(
      { failures: ["existing"], hostingerUnavailable: detail },
      sweep,
      recorder
    );
    expect(result.failures).toEqual(["existing", `Hostinger list failed: ${detail}`]);
  });

  it("keys the two buy-sweeps on different events so a morning flake does not escalate the next hour", () => {
    expect(hostingerListFlakeLogEvent("vps-contract-upgrade-sweep")).toBe(
      "vps_contract_upgrade_sweep_hostinger_list_flake"
    );
    expect(hostingerListFlakeLogEvent("vps-term-renewal-sweep")).toBe(
      "vps_term_renewal_sweep_hostinger_list_flake"
    );
    expect(hostingerListFlakeLogEvent("vps-contract-upgrade-sweep")).not.toBe(
      hostingerListFlakeLogEvent("vps-term-renewal-sweep")
    );
  });
});
