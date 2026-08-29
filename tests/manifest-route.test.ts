import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

const ROOT = join(__dirname, "..");
const m = manifest();

describe("web app manifest", () => {
  it("declares a standalone app so an installed launch has no browser chrome", () => {
    expect(m.display).toBe("standalone");
    expect(m.name).toBe("New Coworker");
    expect(m.short_name).toBeTruthy();
  });

  /**
   * Browsers key an installed app on `id`. Changing it creates a DUPLICATE
   * install for everyone who already added the app and orphans the original,
   * with no migration path and no way to tell them. It is deliberately
   * separate from start_url, which is free to move.
   */
  it("pins a stable install identity", () => {
    expect(m.id).toBe("/dashboard");
  });

  /**
   * Scope "/" and not "/dashboard". A launch with an expired session lands on
   * /login; under a narrower scope that navigation leaves the scope, so the
   * browser evicts it from the standalone window into a normal tab and the
   * owner is looking at Safari instead of the app they tapped. Scope "/" also
   * lets this one registration serve /admin.
   */
  it("scopes to the whole origin so a login redirect stays in the app", () => {
    expect(m.scope).toBe("/");
    expect(m.start_url?.startsWith("/dashboard")).toBe(true);
  });

  it("paints in the same colour the app already declares", () => {
    const layout = readFileSync(join(ROOT, "src/app/layout.tsx"), "utf8");
    const themeColor = /themeColor:\s*"([^"]+)"/.exec(layout)?.[1];
    expect(themeColor, "layout.tsx no longer declares a themeColor").toBeTruthy();
    expect(m.theme_color).toBe(themeColor);
    expect(m.background_color).toBe(themeColor);
  });

  it("ships both icon sizes an install needs", () => {
    const sizes = (m.icons ?? []).map((i) => i.sizes).sort();
    expect(sizes).toEqual(["192x192", "512x512"]);
  });

  /**
   * THE ONE THAT STOPS A FUTURE AUDIT-CHASING CHANGE.
   *
   * logo-192 and logo-512 are the right dimensions but were drawn as plain
   * logos, with no maskable safe zone (the inner 80% Android crops an
   * adaptive icon to). Lighthouse reports a missing maskable icon, and the
   * tempting one-word fix is to tag these "maskable", which trades a small
   * logo inside a white circle for a logo cropped straight through the
   * wordmark. Declaring "any" is the honest answer until a padded asset
   * exists; this test fails the day someone flips it without one.
   */
  it("does not claim a maskable icon it does not have", () => {
    for (const icon of m.icons ?? []) {
      expect(icon.purpose, `${icon.src} claims maskable`).not.toContain("maskable");
    }
  });

  it("points every icon at a file that exists", () => {
    for (const icon of m.icons ?? []) {
      expect(() => readFileSync(join(ROOT, "public", icon.src as string))).not.toThrow();
    }
  });
});
