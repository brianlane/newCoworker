import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("contact page SSR surface", () => {
  it("does not call getAuthUser or read searchParams in the RSC", () => {
    const src = readFileSync(join(import.meta.dirname, "../src/app/contact/page.tsx"), "utf8");
    expect(src).not.toMatch(/getAuthUser/);
    expect(src).not.toMatch(/searchParams/);
    expect(src).not.toMatch(/resolveContactPrefill|resolvePrefill/);
    expect(src).toMatch(/export const revalidate = 3600/);
    expect(src).toMatch(/<ContactForm\s*\/>/);
  });
});
