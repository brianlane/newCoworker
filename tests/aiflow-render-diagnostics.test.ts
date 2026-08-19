import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * Page diagnostics: why a portal did not finish loading itself.
 *
 * Nothing in the render service listened to the page before this. That made
 * every hydration failure indistinguishable from "the control does not exist",
 * because a page whose data requests fail returns REAL html with MISSING
 * controls. Amy's HomeLight referral panel is the case that forced it open: in
 * a real browser it paints a stage editor, through this service the identical
 * click leaves two `--skeleton` placeholders forever, and with no console and
 * no failed-request capture the only tool left was guessing. Guessed selectors
 * have broken this account twice.
 *
 * This is deliberately platform-wide rather than a HomeLight workaround: it is
 * attached to every page the service opens, for every tenant, and returned on
 * successful reads too, because the owner-facing page picker
 * (`src/app/api/aiflows/probe-page/route.ts`) hits the same endpoint and would
 * otherwise silently list fewer controls with no way to say why.
 *
 * `server.mjs` calls `app.listen` at import time, so it is pinned by source the
 * same way `aiflow-render-dockerfile-copies-imports.test.ts` pins its subject.
 */
const server = readFileSync(new URL("../vps/aiflow-render/server.mjs", import.meta.url), "utf8");
const probe = readFileSync(new URL("../debug/portal-dom-probe.ts", import.meta.url), "utf8");
const worker = readFileSync(
  new URL("../supabase/functions/ai-flow-worker/index.ts", import.meta.url),
  "utf8"
);

describe("the render service listens to the page", () => {
  it("captures console errors, uncaught page errors and failed requests", () => {
    for (const evt of ['page.on("console"', 'page.on("pageerror"', 'page.on("requestfailed"']) {
      expect(server).toContain(evt);
    }
  });

  it("also records 4xx/5xx responses, which never fire requestfailed", () => {
    expect(server).toContain('page.on("response"');
    expect(server).toContain("res.status() >= 400");
  });

  it("names our OWN ssrf refusals, so we cannot blame the portal for them", () => {
    // `blockedbyclient` is attachSsrfGuard aborting the request. Surfacing the
    // verbatim reason is the difference between "the portal is broken" and
    // "we broke it".
    expect(server).toContain("req.failure()?.errorText");
    expect(server).toContain("blockedbyclient");
  });

  it("attaches on every page it opens, not just one code path", () => {
    // Two creation sites: the pooled authenticated context and the throwaway one.
    // Call sites only: the bare pattern also matches the function definition.
    expect(server.match(/pageDiagnostics = attachDiagnostics\(page\)/g) ?? []).toHaveLength(2);
  });

  it("bounds what it collects, since a retry loop can emit thousands", () => {
    expect(server).toContain("DIAG_MAX");
    expect(server).toContain("DIAG_TEXT_MAX");
  });

  it("adds nothing to the response when the page had no trouble", () => {
    // summarizeDiagnostics drops empty arrays and returns null, and every call
    // site spreads conditionally, so a healthy page keeps its exact old shape.
    expect(server).toContain("function summarizeDiagnostics");
    expect(server).toMatch(/Object\.keys\(out\)\.length > 0 \? out : null/);
  });

  it("returns them on SUCCESS too, not only on failures", () => {
    // The half-rendered page is the dangerous case: it returns 200 with real
    // html and missing controls. The page picker needs to be able to say so.
    const successSites = server.match(/summarizeDiagnostics\(page\.__diag\)/g) ?? [];
    expect(successSites.length).toBeGreaterThanOrEqual(5);
  });

  it("covers the AUTHENTICATED path, which is the one that actually matters", () => {
    // Bugbot, twice. First cut: listeners attached on the pooled authenticated
    // page but only the UNAUTHENTICATED twins spread the diagnostics, so every
    // credentialed tenant browse and the owner-facing page picker still got a
    // 200 with real html, missing controls and no explanation.
    //
    // Second cut: this test sliced from the first `page.content()`, which is
    // inside `capturePageSource`, so the window already contained the
    // unauthenticated call sites and would have passed while the authenticated
    // path regressed. Anchor on a string that appears ONLY in the credentialed
    // handler, and assert uniqueness so the anchor itself cannot rot.
    const marker = "render_failed (authenticated";
    expect(server.split(marker)).toHaveLength(2);
    const at = server.indexOf(marker);

    // The credentialed SUCCESS return sits immediately above that catch.
    const authSuccess = server.slice(Math.max(0, at - 1200), at);
    expect(authSuccess).toContain("summarizeDiagnostics(page.__diag)");
    expect(authSuccess).toContain("finalUrl: page.url()");

    // And the credentialed FAILURE return sits immediately below it.
    const authCatch = server.slice(at, at + 1200);
    expect(authCatch).toContain("summarizeDiagnostics(page.__diag)");
  });
});

describe("the worker records them, so every tenant's failure keeps the reason", () => {
  it("reads diagnostics off any render response", () => {
    expect(worker).toContain("function readRenderDiagnostics");
  });

  it("carries them into a login failure", () => {
    expect(worker).toMatch(/loginWhy/);
  });

  it("carries them into an action failure, which is the missing-control case", () => {
    expect(worker).toContain("readRenderDiagnostics(parsedBody)");
  });

  it("carries them into a TRANSIENT render failure too", () => {
    // Bugbot: pageDiag was read and then used only on the login arm, so a
    // transient browse failure stored a bare "render service error
    // (render_failed)" and threw the page's own account away.
    const at = worker.indexOf("throw new RenderFailedError(");
    expect(at).toBeGreaterThan(-1);
    expect(worker.slice(Math.max(0, at - 400), at)).toContain("pageDiag");
  });

  it("bounds the stored string, which shares ai_flow_runs.last_error", () => {
    expect(worker).toMatch(/slice\(0, 600\)/);
  });

  it("summarizes rather than dumping, so one kind cannot crowd out the others", () => {
    expect(worker).toContain("items.slice(0, 2)");
  });
});

describe("the probe names our own refusals correctly", () => {
  it("matches Chromium's errorText, not the abort argument we passed", () => {
    // Bugbot: the guard aborts with `route.abort("blockedbyclient")`, but
    // Chromium reports it back as `net::ERR_BLOCKED_BY_CLIENT`. Looking for the
    // lowercase argument never fires, which leaves OUR refusals looking like
    // portal failures: precisely what the note exists to prevent.
    expect(probe).toMatch(/replace\(\/\[\^a-z\]\/g, ""\)/);
    expect(probe).toContain('includes("blockedbyclient")');
    expect(probe).toContain("ERR_BLOCKED_BY_CLIENT is OUR ssrf guard");
  });

  it("prints diagnostics on the success path as well as on failure", () => {
    expect((probe.match(/reportDiagnostics\(body\.diagnostics\)/g) ?? []).length).toBe(2);
  });
});

describe("the user agent cannot disagree with the engine", () => {
  it("derives its Chrome version from browser.version(), not a literal", () => {
    // The old override pinned "Chrome/124.0" while Playwright bumps moved the
    // real engine on. A UA whose claimed version disagrees with the engine's
    // fingerprint is a quiet bot signal: HomeLight answered our lazy-loaded
    // script chunks with an HTML page, and the stage editor never mounted
    // ("Unexpected token '<'"). Deriving the version means there is no second
    // copy of the number to forget on the next Playwright bump.
    expect(server).toContain("Chrome/${browser.version()}");
    expect(server).not.toMatch(/Chrome\/\d/);
  });

  it("still overrides the default, which says HeadlessChrome", () => {
    // Three sites: both context creations, plus the CDP client-hint override,
    // which must carry the SAME string or the two channels contradict again.
    expect(server.match(/userAgent: uaFor\(browser\)/g) ?? []).toHaveLength(3);
  });
});

describe("client hints cannot contradict the UA string", () => {
  it("overrides Sec-CH-UA metadata via CDP on every page", () => {
    // The userAgent context option rewrites only the UA HEADER. Headless
    // Chromium kept broadcasting "HeadlessChrome" through Sec-CH-UA client
    // hints, visible verbatim in HomeLight's own analytics beacon
    // (uafvl=...|HeadlessChrome...). A CDN keying on client hints answers
    // script chunks with an HTML challenge, the document still loads, and the
    // page half-renders: "Unexpected token '<'".
    expect(server).toContain('session.send("Emulation.setUserAgentOverride"');
    expect(server).toContain("userAgentMetadata");
    expect((server.match(/await alignClientHints\(page, /g) ?? []).length).toBe(2);
  });

  it("derives brands from the engine, with the GREASE brand real Chrome ships", () => {
    expect(server).toContain('{ brand: "Chromium", version: major }');
    expect(server).toContain('{ brand: "Not=A?Brand", version: "99" }');
  });

  it("degrades to today's behavior when CDP fails, never breaking the render", () => {
    expect(server).toContain("client-hint alignment failed (continuing)");
  });
});

describe("navigator.webdriver does not give the game away", () => {
  it("launches with AutomationControlled disabled", () => {
    // The oldest bot tell there is, and the one that survived fixing the UA
    // string and the client hints. Chromium's own flag for it.
    expect(server).toContain('"--disable-blink-features=AutomationControlled"');
  });
});
