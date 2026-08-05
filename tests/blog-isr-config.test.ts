import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

describe("blog ISR config", () => {
  it("uses revalidate instead of force-dynamic on public blog surfaces", () => {
    const files = [
      "src/app/(marketing)/blog/page.tsx",
      "src/app/(marketing)/blog/[slug]/page.tsx",
      "src/app/(marketing)/blog/feed.xml/route.ts"
    ];
    for (const rel of files) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, rel).toMatch(/export const revalidate = 60/);
      expect(src, rel).not.toMatch(/force-dynamic/);
    }
  });

  it("keeps token unsubscribe dynamic", () => {
    const src = readFileSync(join(ROOT, "src/app/(marketing)/blog/unsubscribe/page.tsx"), "utf8");
    expect(src).toMatch(/force-dynamic/);
  });
});
