/**
 * GET /api/brand-logo, serves the brand logo behind the public /logo.png URL.
 *
 * The point of this route is that a response Next produces keeps our
 * Access-Control-Allow-Origin, whereas the platform's static serving of
 * public/logo.png replaced it with `*` on any request carrying an Origin
 * header. That wildcard was the last open CASA finding, so the rewrite that
 * puts this route in front of the file is pinned here too.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { GET } from "@/app/api/brand-logo/route";
import nextConfig from "../next.config";

describe("GET /api/brand-logo", () => {
  it("serves a PNG", () => {
    const res = GET();
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("serves the actual bytes of public/logo.png", async () => {
    const served = Buffer.from(await GET().arrayBuffer());
    const onDisk = readFileSync(path.join(process.cwd(), "public", "logo.png"));

    expect(served.length).toBe(onDisk.length);
    expect(served.equals(onDisk)).toBe(true);
    // PNG magic number, so a truncated or wrong-format read fails loudly.
    expect(served.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("is cacheable, since the bytes only change on deploy", () => {
    expect(GET().headers.get("cache-control")).toContain("max-age=");
  });
});

describe("next.config /logo.png rewrite", () => {
  it("routes /logo.png to the handler before the static file is considered", async () => {
    const rewrites = nextConfig.rewrites;
    if (!rewrites) throw new Error("next.config.ts defines no rewrites()");
    const result = (await rewrites()) as { beforeFiles: { source: string; destination: string }[] };

    // beforeFiles specifically: afterFiles would lose to public/logo.png and
    // the wildcard would come straight back.
    expect(result.beforeFiles).toContainEqual({
      source: "/logo.png",
      destination: "/api/brand-logo"
    });
  });

  it("force-includes the logo in the route's bundle", () => {
    // The handler builds its path at runtime, so tracing cannot find the file
    // without this. Missing it means a 500 in production but a green test run.
    expect(nextConfig.outputFileTracingIncludes?.["/api/brand-logo"]).toContain(
      "./public/logo.png"
    );
  });
});
