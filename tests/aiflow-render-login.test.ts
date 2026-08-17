import { describe, it, expect } from "vitest";
import {
  firstSelector,
  looksLikeLogin,
  performLogin,
  resolveSubmit,
  SUBMIT_SELECTORS,
  USERNAME_SELECTORS
} from "../vps/aiflow-render/login.mjs";

/**
 * LOGIN-mode tests for the per-tenant render sidecar.
 *
 * The engine used to live inside `vps/aiflow-render/server.mjs`, which calls
 * `app.listen` at import time and exported none of it, so nothing here could be
 * tested. It now lives in `login.mjs` and takes a Playwright `page` as a
 * parameter, which is all these tests need: a stub page whose locators return
 * scripted answers for `count` / `isEnabled` / `click` / `blur` / `press`.
 *
 * What is being pinned is one production incident. On 2026-08-17 Amy Laidlaw's
 * Clever credentials were correct and worked in a normal browser, and every
 * attempt through this service returned a bare `login_failed`. Clever's submit
 * control is
 *
 *   <button type="button" class="... button--disabled" disabled=""
 *           data-testid="Button">Log In</button>
 *
 * so the old routine could not match it (its chain led with
 * `button[type="submit"]`), would have selected it while DISABLED even if it
 * had (selection asked only `.count()`), and threw the reason away when the
 * click timed out (`.click().catch(() => {})`).
 */

type LocatorScript = {
  /** How many elements the locator resolves to. */
  count?: number;
  /** Whether the control can take a click. Defaults to true. */
  enabled?: boolean;
  /** Counts answered one per `isEnabled()` call, last value repeating. */
  enabledSeq?: boolean[];
  /** Reject `click()` with this message (models an actionability timeout). */
  clickError?: string;
};

function stubPage(script: Record<string, LocatorScript>) {
  const calls = {
    filled: [] as Array<{ selector: string; value: string }>,
    clicked: [] as string[],
    pressed: [] as string[],
    blurred: [] as string[]
  };
  const seqIndex = new Map<string, number>();

  const page = {
    calls,
    locator(selector: string) {
      const s = script[selector] ?? { count: 0 };
      const self = {
        first: () => self,
        count: async () => s.count ?? 0,
        isEnabled: async () => {
          if (s.enabledSeq) {
            const i = seqIndex.get(selector) ?? 0;
            seqIndex.set(selector, i + 1);
            return s.enabledSeq[Math.min(i, s.enabledSeq.length - 1)];
          }
          return s.enabled ?? true;
        },
        click: async () => {
          if (s.clickError) throw new Error(s.clickError);
          calls.clicked.push(selector);
        },
        blur: async () => {
          calls.blurred.push(selector);
        },
        press: async () => {
          calls.pressed.push(selector);
        }
      };
      return self;
    },
    async fill(selector: string, value: string) {
      calls.filled.push({ selector, value });
    },
    async waitForTimeout() {
      /* no-op in tests */
    }
  };
  return page;
}

/** The Clever login form as it actually shipped on 2026-08-17. */
function cleverPage(opts: { enablesAfterBlur: boolean }) {
  return stubPage({
    'input[type="email"]': { count: 1 },
    'input[type="password"]': { count: 1 },
    // type="button", so neither native-submit selector can ever match it.
    'button[type="submit"]': { count: 0 },
    'input[type="submit"]': { count: 0 },
    'button:has-text("Log in")': {
      count: 1,
      // Disabled at rest; validation-on-blur is what flips it.
      enabled: opts.enablesAfterBlur,
      ...(opts.enablesAfterBlur ? {} : { clickError: "Timeout 10000ms exceeded" })
    }
  });
}

describe("looksLikeLogin", () => {
  it("needs BOTH a password and a username field", async () => {
    const passOnly = stubPage({ 'input[type="password"]': { count: 1 } });
    expect(await looksLikeLogin(passOnly, undefined)).toBe(false);

    const both = stubPage({
      'input[type="password"]': { count: 1 },
      'input[type="email"]': { count: 1 }
    });
    expect(await looksLikeLogin(both, undefined)).toBe(true);
  });

  it("is false on a page with no password field at all", async () => {
    const page = stubPage({ 'input[type="email"]': { count: 1 } });
    expect(await looksLikeLogin(page, undefined)).toBe(false);
  });

  it("honours explicit selector overrides", async () => {
    const page = stubPage({ "#pw": { count: 1 }, "#user": { count: 1 } });
    expect(
      await looksLikeLogin(page, { passwordSelector: "#pw", usernameSelector: "#user" })
    ).toBe(true);
  });
});

describe("resolveSubmit", () => {
  it("reaches a type=button control by its accessible text", async () => {
    // The Clever regression in one assertion: the native-submit selectors miss,
    // and the text selector is what finds the real control.
    const page = cleverPage({ enablesAfterBlur: true });
    const submit = await resolveSubmit(page, undefined);
    expect(submit).toEqual({ selector: 'button:has-text("Log in")', enabled: true });
  });

  it("prefers an ENABLED candidate over an earlier disabled one", async () => {
    const page = stubPage({
      'button[type="submit"]': { count: 1, enabled: false },
      'button:has-text("Log in")': { count: 1, enabled: true }
    });
    const submit = await resolveSubmit(page, undefined);
    expect(submit?.selector).toBe('button:has-text("Log in")');
    expect(submit?.enabled).toBe(true);
  });

  it("still returns a disabled control, flagged, rather than nothing", async () => {
    // Reporting enabled:false is what lets login_failed say the button never
    // became clickable instead of saying nothing at all.
    const page = cleverPage({ enablesAfterBlur: false });
    const submit = await resolveSubmit(page, undefined);
    expect(submit).toEqual({ selector: 'button:has-text("Log in")', enabled: false });
  });

  it("returns null when no candidate is present", async () => {
    expect(await resolveSubmit(stubPage({}), undefined)).toBeNull();
  });

  it("puts an explicit submitSelector override first", async () => {
    const page = stubPage({
      "#go": { count: 1, enabled: true },
      'button[type="submit"]': { count: 1, enabled: true }
    });
    const submit = await resolveSubmit(page, { submitSelector: "#go" });
    expect(submit?.selector).toBe("#go");
  });
});

describe("performLogin", () => {
  it("fills, blurs, then submits", async () => {
    const page = cleverPage({ enablesAfterBlur: true });
    const diag = await performLogin(page, { username: "amy@example.com", password: "pw" }, undefined);

    expect(page.calls.filled).toEqual([
      { selector: 'input[type="email"]', value: "amy@example.com" },
      { selector: 'input[type="password"]', value: "pw" }
    ]);
    // The blur is load-bearing: a validate-on-blur form never enables its
    // submit button without it, which is precisely why Clever never logged in.
    expect(page.calls.blurred).toEqual(['input[type="password"]']);
    expect(page.calls.clicked).toEqual(['button:has-text("Log in")']);
    expect(diag.clickError).toBeNull();
    expect(diag.submitEnabled).toBe(true);
  });

  it("blurs BEFORE resolving the submit control", async () => {
    // Ordering matters: resolve first and a validation-gated button is still
    // disabled, so we would report enabled:false for a form that was fine.
    const page = stubPage({
      'input[type="email"]': { count: 1 },
      'input[type="password"]': { count: 1 },
      'button[type="submit"]': { count: 1, enabledSeq: [true] }
    });
    const diag = await performLogin(page, { username: "u", password: "p" }, undefined);
    expect(page.calls.blurred.length).toBe(1);
    expect(diag.submitEnabled).toBe(true);
  });

  it("keeps the click error instead of swallowing it", async () => {
    // The old line was `.click().catch(() => {})`, so a disabled button raised
    // nothing and the caller reported a bare `login_failed`.
    const page = cleverPage({ enablesAfterBlur: false });
    const diag = await performLogin(page, { username: "u", password: "p" }, undefined);

    expect(diag.clickError).toContain("Timeout");
    expect(diag.submitEnabled).toBe(false);
    expect(diag.selectors.submit).toBe('button:has-text("Log in")');
    // and it still tries the native path rather than giving up silently
    expect(page.calls.pressed).toEqual(['input[type="password"]']);
  });

  it("falls back to Enter when the page has no submit control", async () => {
    const page = stubPage({
      'input[type="email"]': { count: 1 },
      'input[type="password"]': { count: 1 }
    });
    const diag = await performLogin(page, { username: "u", password: "p" }, undefined);
    expect(page.calls.pressed).toEqual(['input[type="password"]']);
    expect(diag.selectors.submit).toBeNull();
  });

  it("throws only when the form itself is missing", async () => {
    // This is the one case that IS a permanent setup error, and the only one
    // the caller should turn into auth_config_error.
    await expect(
      performLogin(stubPage({}), { username: "u", password: "p" }, undefined)
    ).rejects.toThrow("login_form_not_found");
  });

  it("does not throw when the submit merely failed to land", async () => {
    // Throwing here would make a slow page a PERMANENT run failure. The caller
    // re-navigates and re-checks; that second check is the authority.
    const page = cleverPage({ enablesAfterBlur: false });
    await expect(
      performLogin(page, { username: "u", password: "p" }, undefined)
    ).resolves.toMatchObject({ submitEnabled: false });
  });

  it("reports a blur that could not run without failing the login", async () => {
    const page = stubPage({
      'input[type="email"]': { count: 1 },
      'input[type="password"]': { count: 1 },
      'button[type="submit"]': { count: 1, enabled: true }
    });
    // Model a page whose blur rejects.
    const original = page.locator.bind(page);
    page.locator = (selector: string) => {
      const loc = original(selector);
      if (selector === 'input[type="password"]') {
        return { ...loc, first: () => ({ ...loc, blur: async () => { throw new Error("detached"); } }) };
      }
      return loc;
    };
    const diag = await performLogin(page, { username: "u", password: "p" }, undefined);
    expect(diag.blurred).toBe(false);
  });
});

describe("selector tables", () => {
  it("orders native submit selectors before text matches", async () => {
    // A conventional form must keep taking the conventional path; the text
    // selectors exist for controls like Clever's that are not submit buttons.
    expect(SUBMIT_SELECTORS.indexOf('button[type="submit"]')).toBeLessThan(
      SUBMIT_SELECTORS.indexOf('button:has-text("Log in")')
    );
  });

  it("never offers a bare Continue as a submit candidate", () => {
    // Bugbot, PR #1419: resolveSubmit prefers an ENABLED candidate, so on a page
    // whose real submit is still validation-disabled, any live "Continue" (SSO
    // step, cookie banner, or the very modal HomeLight's text-claim path
    // dismisses) would take the click instead.
    expect(SUBMIT_SELECTORS.some((s) => /continue/i.test(s))).toBe(false);
  });

  it("matches an email input by autocomplete as well as type", async () => {
    // Clever's field carries autocomplete="email"; HomeLight's client sign-in
    // is a bare text input with no name, which is why the list is this long.
    expect(USERNAME_SELECTORS).toContain('input[autocomplete="email"]');
  });

  it("firstSelector skips absent candidates and tolerates a throwing locator", async () => {
    const page = stubPage({ "#b": { count: 1 } });
    expect(await firstSelector(page, [undefined, "#a", "#b"])).toBe("#b");
    expect(await firstSelector(page, ["#a"])).toBeNull();
  });
});
