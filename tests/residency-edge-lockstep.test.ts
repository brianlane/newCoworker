import { describe, expect, it } from "vitest";

import {
  EDGE_RESIDENCY_MOVED_TABLES,
  edgeResidencyDataBaseUrl
} from "../supabase/functions/_shared/residency";
import { DATA_API_FILTER_OPS, dataApiHostname } from "@/lib/residency/contract";
import { RESIDENCY_MOVED_TABLES } from "@/lib/residency/tables";
import { residencyDataBaseUrl } from "@/lib/residency/client";

/**
 * The edge helper mirrors src/lib/residency/* because Deno cannot import
 * `@/lib/*`. Four copies of the moved-table list now exist (app, box,
 * journal migration, edge); this pins the edge one, and asserts the two URL
 * builders agree, because a hostname that differs by a character means the
 * engine and the dashboard read DIFFERENT boxes for the same tenant.
 */
describe("edge residency mirror", () => {
  it("mirrors RESIDENCY_MOVED_TABLES exactly, in the same order", () => {
    expect([...EDGE_RESIDENCY_MOVED_TABLES]).toEqual([...RESIDENCY_MOVED_TABLES]);
  });

  it("builds the same base URL the dashboard does", () => {
    const biz = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
    const prev = {
      suffix: process.env.CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX,
      zone: process.env.CLOUDFLARE_TUNNEL_ZONE
    };
    try {
      // Default, then each env layer, then the blank-coercion that a
      // set-but-empty var must fall through rather than yield "data-<id>.".
      for (const [suffix, zone] of [
        [undefined, undefined],
        ["tunnel.example.com", undefined],
        [undefined, "zone.example.com"],
        ["   ", "zone.example.com"],
        ["", ""]
      ] as Array<[string | undefined, string | undefined]>) {
        if (suffix === undefined) delete process.env.CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX;
        else process.env.CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX = suffix;
        if (zone === undefined) delete process.env.CLOUDFLARE_TUNNEL_ZONE;
        else process.env.CLOUDFLARE_TUNNEL_ZONE = zone;
        expect(edgeResidencyDataBaseUrl(biz)).toBe(residencyDataBaseUrl(biz));
      }
    } finally {
      if (prev.suffix === undefined) delete process.env.CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX;
      else process.env.CLOUDFLARE_TUNNEL_HOSTNAME_SUFFIX = prev.suffix;
      if (prev.zone === undefined) delete process.env.CLOUDFLARE_TUNNEL_ZONE;
      else process.env.CLOUDFLARE_TUNNEL_ZONE = prev.zone;
    }
  });

  it("uses the contract's own hostname builder shape", () => {
    const biz = "biz-1";
    expect(edgeResidencyDataBaseUrl(biz)).toBe(
      `https://${dataApiHostname(biz, "newcoworker.com")}`
    );
  });

  it("declares no filter op the platform contract does not have", async () => {
    // The edge type is a union literal, so read it from source rather than
    // from a runtime value that does not exist.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "..", "supabase", "functions", "_shared", "residency.ts"),
      "utf8"
    );
    const block = /export type EdgeDataApiFilterOp =([\s\S]*?);/.exec(src)?.[1];
    expect(block, "EdgeDataApiFilterOp is gone or renamed").toBeTruthy();
    const ops = [...(block ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(ops.length, "the op extractor found nothing, it did not pass").toBeGreaterThan(5);
    expect([...ops].sort()).toEqual([...DATA_API_FILTER_OPS].sort());
  });
});
