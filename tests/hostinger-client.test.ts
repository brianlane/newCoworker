import { describe, expect, it, vi } from "vitest";
import { HostingerClient } from "@/lib/hostinger/client";

describe("hostinger client", () => {
  it("provisions vps", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ vpsId: "vps_123" })));
    const client = new HostingerClient("https://mock.hostinger", "token", fetchMock as any);
    await expect(client.provisionVps("kvm8", "snap1")).resolves.toEqual({ vpsId: "vps_123" });
  });

  it("reboots vps", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const client = new HostingerClient("https://mock.hostinger", "token", fetchMock as any);
    await expect(client.rebootVps("vps_123")).resolves.toEqual({ ok: true });
  });

  it("returns metrics", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ cpuPercent: 10, ramPercent: 20 }))
    );
    const client = new HostingerClient("https://mock.hostinger", "token", fetchMock as any);
    await expect(client.getMetrics("vps_123")).resolves.toEqual({ cpuPercent: 10, ramPercent: 20 });
  });

  it("throws on non-200 response", async () => {
    const fetchMock = vi.fn(async () => new Response("fail", { status: 500 }));
    const client = new HostingerClient("https://mock.hostinger", "token", fetchMock as any);
    await expect(client.getMetrics("vps_123")).rejects.toThrow("Hostinger API error: 500");
  });
});
