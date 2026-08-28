import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPushPayload } from "@/lib/push/payload";

/**
 * public/sw.js is not typechecked, not bundled, and not imported by anything,
 * so no compiler and no unit test can reach it. eslint.config.mjs runs
 * no-undef over it, which catches a call to a name that does not exist. This
 * file catches the three couplings a linter cannot see: the payload contract
 * with its producer, the API paths it calls, and the structural rules that
 * keep it a classic worker with no cache.
 *
 * The stakes are why this exists at all. A broken service worker fails inside
 * a push event, on a device we do not own, and the only symptom is that an
 * urgent alert silently never arrived.
 */

const ROOT = join(__dirname, "..");
const SW_PATH = join(ROOT, "public/sw.js");
const source = readFileSync(SW_PATH, "utf8");

describe("service worker contract", () => {
  it.each([
    "install",
    "activate",
    "push",
    "notificationclick",
    "pushsubscriptionchange",
    "fetch"
  ])("registers a %s listener", (event) => {
    expect(source).toContain(`addEventListener("${event}"`);
  });

  /**
   * The producer/consumer coupling. buildPushPayload owns the field names and
   * the worker reads them by hand; nothing else can prove they agree. A
   * rename on either side ships green and silently degrades every push to the
   * generic fallback text.
   */
  it("reads exactly the keys buildPushPayload produces, and no others", () => {
    const produced = Object.keys(
      JSON.parse(
        buildPushPayload({
          title: "T",
          body: "B",
          url: "/dashboard",
          notificationId: "11111111-1111-1111-1111-111111111111",
          tag: "tag"
        })
      )
    ).sort();

    // The worker names the parsed payload `pushData` precisely so this match
    // cannot collide with `event.data.json()` or with the `.data` envelope our
    // own API routes return.
    const read = new Set(
      Array.from(source.matchAll(/\bpushData\.(\w+)\b/g)).map((m) => m[1])
    );

    for (const key of produced) {
      expect(read.has(key), `the worker never reads data.${key}`).toBe(true);
    }
    for (const key of read) {
      expect(produced.includes(key), `the worker reads data.${key}, which is never sent`).toBe(
        true
      );
    }
  });

  /**
   * The direct analogue of the no-undef catch, for routes. Renaming or moving
   * an endpoint leaves the worker pointing at a 404 that only manifests as a
   * receipt that never records.
   */
  it("only calls API paths that exist on disk", () => {
    const paths = Array.from(source.matchAll(/["'](\/api\/[a-z0-9/-]+)["']/gi)).map((m) => m[1]);
    expect(paths.length, "no API paths found, so this assertion is vacuous").toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith("/api/push/"), `${path} is outside /api/push`).toBe(true);
      const routeFile = join(ROOT, "src/app", path, "route.ts");
      expect(existsSync(routeFile), `${path} has no route at src/app${path}/route.ts`).toBe(true);
    }
  });

  /**
   * Registered as a classic script (see the sourceType in eslint.config.mjs).
   * A stray `import` would be a runtime SyntaxError that silently unregisters
   * the worker in the field.
   */
  it("is a classic script, with no module syntax", () => {
    expect(/^\s*import\s/m.test(source)).toBe(false);
    expect(/^\s*export\s/m.test(source)).toBe(false);
  });

  it("takes control immediately instead of waiting for every tab to close", () => {
    expect(source).toContain("skipWaiting");
    expect(source).toContain("clients.claim");
  });

  /**
   * This app is a Next build with content-hashed chunks. A cache-first worker
   * over it is how you serve an owner a three-week-old dashboard shell, so the
   * Cache API is banned outright rather than used carefully.
   */
  it("never touches the Cache API", () => {
    expect(source).not.toContain("caches.");
    expect(source).not.toContain("cache.put");
  });

  it("only intercepts navigations", () => {
    expect(source).toContain('event.request.mode !== "navigate"');
    // Exactly one respondWith: a second would mean some other request class is
    // being served by the worker.
    expect(source.match(/event\.respondWith\(/g)?.length).toBe(1);
  });

  /**
   * Chrome enforces the userVisibleOnly contract the subscription was granted
   * under: a push that shows nothing makes the browser post its own "site
   * updated in the background" notice, and repeated violations revoke the
   * permission outright. So the handler must never be able to return without
   * showing something.
   */
  it("always shows a notification, with a fallback for an unparseable payload", () => {
    expect(source).toContain("showNotification");
    expect(source).toContain("FALLBACK_TITLE");
    expect(source).toContain("FALLBACK_BODY");
  });

  /**
   * "Starts with /" is not enough: "//evil.example.com" is protocol-relative
   * and resolves off-origin, which would let a notification navigate the owner
   * to another site.
   */
  it("refuses an off-origin tap target", () => {
    expect(source).toContain('startsWith("//")');
  });

  /**
   * An endpoint is a bearer capability. Accepting one as proof of identity
   * would let anybody holding a leaked endpoint rebind the owner's alerts to
   * their own browser, so re-subscription authenticates on the session cookie.
   */
  it("re-subscribes with credentials, never with the old endpoint as proof", () => {
    expect(source).toContain('credentials: "same-origin"');
    expect(source).not.toContain("previousEndpoint");
  });
});
