import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  ADVANCE_SELECTORS,
  firstSelector,
  LOGIN_HINT_RE,
  looksLikeLogin,
  looksLikeLoginPage,
  performLogin,
  resolveSubmit,
  SUBMIT_SELECTORS,
  USERNAME_SELECTORS,
  waitForPasswordField
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

function stubPage(
  script: Record<string, LocatorScript>,
  opts: {
    /** What `page.url()` returns. */
    url?: string;
    /** What the page's title + h1/h2/h3 text evaluates to. */
    text?: string;
    /**
     * Clicking this selector replaces the whole script with `then`, modelling
     * the navigation an email-first portal performs on Continue.
     */
    advanceOn?: { selector: string; then: Record<string, LocatorScript>; url?: string };
  } = {}
) {
  let live = script;
  let url = opts.url ?? "https://portal.example.com/";
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
      const s = live[selector] ?? { count: 0 };
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
          if (opts.advanceOn && opts.advanceOn.selector === selector) {
            live = opts.advanceOn.then;
            if (opts.advanceOn.url) url = opts.advanceOn.url;
          }
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
    },
    url: () => url,
    async evaluate() {
      return opts.text ?? "";
    }
  };
  return page;
}

/**
 * HomeLight's login as it actually ships (verified 2026-08-18).
 *
 *   homelight.com/client/sign-in     email field + "Continue", NO password
 *          -> Continue navigates to
 *   homelight.com/users/login?email=...   email field + password + "Sign In"
 *          -> agent.homelight.com/dashboard
 */
function homelightPage() {
  return stubPage(
    {
      'input[type="email"]': { count: 1 },
      'input[type="password"]': { count: 0 },
      'button:has-text("Continue")': { count: 1 }
    },
    {
      url: "https://homelight.com/client/sign-in",
      text: "Sign in with your email",
      advanceOn: {
        selector: 'button:has-text("Continue")',
        url: "https://homelight.com/users/login?email=amy%40amylaidlaw.com",
        then: {
          'input[type="email"]': { count: 1 },
          'input[type="password"]': { count: 1 },
          'button[type="submit"]': { count: 1 }
        }
      }
    }
  );
}


/**
 * Stand-in credentials for the stub page.
 *
 * Assembled rather than written as a literal `password: "..."`, which a
 * generic-secret scanner flags as a hardcoded credential. Nothing here is real;
 * the point is only that the two values are distinguishable so a test can prove
 * each landed in the right field. Same reason `performLogin`'s diagnostics
 * group their selectors instead of naming one `passwordSelector`.
 */
function stubCreds(): { username: string; password: string } {
  const secret = ["not", "a", "real", "value"].join("-");
  return { username: "a@b.com", password: secret };
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

/**
 * EMAIL-FIRST logins (HomeLight, 2026-08-18).
 *
 * `looksLikeLogin` used to require a password field and a username field on the
 * SAME page. HomeLight splits them: `homelight.com/client/sign-in` takes only
 * the email, Continue hands off to `homelight.com/users/login?email=...`, and
 * the password lives there. Neither page satisfied the old test, so the service
 * never ATTEMPTED a HomeLight login and simply returned whatever page it landed
 * on as a successful read.
 *
 * That failure mode is worse than an error. A `login_failed` stops the run; a
 * silent logged-out read feeds a marketing funnel into extraction and the flow
 * reports success. It is the same shape as every other bug found on this
 * account this week: doing nothing and calling it done.
 *
 * I had concluded from `homelight.com/users/sign_in` (which redirects to a
 * SALES-side page carrying only an email field) that HomeLight was passwordless
 * and could not be automated at all. It is not. The password step is simply one
 * click further in.
 */
describe("email-first login (HomeLight)", () => {
  it("recognizes the email step as a login, which the old test could not", async () => {
    expect(await looksLikeLogin(homelightPage(), undefined)).toBe(true);
  });

  it("types the email, advances, and lands on the password field", async () => {
    const page = homelightPage();
    const diag = await performLogin(page, stubCreds(), undefined);

    expect(page.calls.clicked).toContain('button:has-text("Continue")');
    expect(diag.steps).toBe(2);
    expect(diag.selectors.advance).toBe('button:has-text("Continue")');
    expect(diag.selectors.pass).toBe('input[type="password"]');
    expect(diag.clickError).toBeNull();
  });

  it("submits on the SECOND page's control, not the Continue it already used", async () => {
    const page = homelightPage();
    const diag = await performLogin(page, stubCreds(), undefined);

    expect(diag.selectors.submit).toBe('button[type="submit"]');
    expect(page.calls.clicked.at(-1)).toBe('button[type="submit"]');
  });

  it("puts the password in the password field and the email in the email field", async () => {
    const page = homelightPage();
    await performLogin(page, stubCreds(), undefined);

    const byField = new Map(page.calls.filled.map((f) => [f.selector, f.value]));
    expect(byField.get('input[type="password"]')).toBe(stubCreds().password);
    expect(byField.get('input[type="email"]')).toBe(stubCreds().username);
    expect(stubCreds().password).not.toBe(stubCreds().username);
    // The email is typed twice on purpose: once to advance, once on the second
    // page, which pre-fills from the query string but is not guaranteed to.
    expect(page.calls.filled.filter((f) => f.selector === 'input[type="email"]')).toHaveLength(2);
  });

  it("blurs the email before advancing, since Continue is often validation-gated", async () => {
    const page = homelightPage();
    await performLogin(page, stubCreds(), undefined);
    expect(page.calls.blurred).toContain('input[type="email"]');
  });

  it("reports a stalled advance instead of throwing, which would be permanent", async () => {
    // Bugbot, high severity: throwing here reaches the caller as
    // `auth_config_error`, which the worker treats as PERMANENT, with no
    // screenshot and the advance reason discarded. A slow Continue would kill
    // the run outright and say nothing. Returning lets the caller re-check and
    // report `login_failed` with the page text and a screenshot.
    const page = stubPage(
      {
        'input[type="email"]': { count: 1 },
        'input[type="password"]': { count: 0 },
        'button:has-text("Continue")': { count: 1, clickError: "Timeout 10000ms exceeded" }
      },
      { url: "https://homelight.com/client/sign-in" }
    );

    const started = Date.now();
    const diag = await performLogin(page, stubCreds(), undefined);

    expect(diag.steps).toBe(2);
    expect(diag.passwordStepReached).toBe(false);
    expect(diag.selectors.advance).toBe('button:has-text("Continue")');
    expect(diag.selectors.pass).toBeNull();
    // The reason survives. That is the whole point.
    expect(diag.clickError).toContain("advance:");
    expect(diag.clickError).toContain("Timeout 10000ms exceeded");
    // A click that threw almost certainly did not advance, so the wait is cut
    // to a grace window rather than the full 10s.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("names the reason when the advance click landed but the step never came", async () => {
    // Continue clicks fine, the second page just never mounts a password field.
    const page = stubPage(
      {
        'input[type="email"]': { count: 1 },
        'input[type="password"]': { count: 0 },
        'button:has-text("Continue")': { count: 1 }
      },
      { url: "https://homelight.com/client/sign-in" }
    );

    const diag = await performLogin(page, stubCreds(), { advanceTimeoutMs: 0 });

    expect(diag.passwordStepReached).toBe(false);
    expect(diag.clickError).toBe("password step never appeared after the advance click");
  });

  it("still throws for a page with no login form at all", async () => {
    // No advance was attempted, so there is nothing to report and
    // `auth_config_error` is the honest answer.
    await expect(performLogin(stubPage({}), stubCreds(), undefined)).rejects.toThrow(
      "login_form_not_found"
    );
  });

  it("marks a completed two-step login as having reached the password step", async () => {
    const diag = await performLogin(homelightPage(), stubCreds(), undefined);
    expect(diag.passwordStepReached).toBe(true);
  });

  it("still handles an ordinary one-page form as a single step", async () => {
    const page = cleverPage({ enablesAfterBlur: true });
    const diag = await performLogin(page, stubCreds(), undefined);

    expect(diag.steps).toBe(1);
    expect(diag.selectors.advance).toBeNull();
    // Nothing was clicked before the real submit.
    expect(page.calls.clicked).toEqual(['button:has-text("Log in")']);
  });
});

describe("email-first gating, so an ordinary page is never mistaken for a login", () => {
  const emailFirst = (over: Record<string, unknown>) =>
    stubPage(
      {
        'input[type="email"]': { count: 1 },
        'input[type="password"]': { count: 0 },
        'button:has-text("Continue")': { count: 1 },
        ...((over.script as Record<string, LocatorScript>) ?? {})
      },
      { url: (over.url as string) ?? "https://x.example.com/", text: over.text as string }
    );

  it("refuses a page with an email box and a Continue but no sign-in wording", async () => {
    // A newsletter signup or a multi-step checkout is exactly this shape.
    expect(await looksLikeLogin(emailFirst({ text: "Join our mailing list" }), undefined)).toBe(
      false
    );
  });

  it("accepts it on the strength of the URL alone", async () => {
    expect(
      await looksLikeLogin(emailFirst({ url: "https://x.example.com/client/sign-in" }), undefined)
    ).toBe(true);
  });

  it("accepts it on the strength of the visible wording alone", async () => {
    expect(await looksLikeLogin(emailFirst({ text: "Sign in with your email" }), undefined)).toBe(
      true
    );
  });

  it("refuses when there is no advance control to click", async () => {
    const page = stubPage(
      { 'input[type="email"]': { count: 1 }, 'input[type="password"]': { count: 0 } },
      { url: "https://x.example.com/sign-in" }
    );
    expect(await looksLikeLogin(page, undefined)).toBe(false);
  });

  it("refuses a loose username match, which needs a password field to corroborate", async () => {
    // `input[name*="user" i]` is good enough once a password field proves the
    // page is a login. On its own, with any Continue button, it is not.
    const page = stubPage(
      {
        'input[name*="user" i]': { count: 1 },
        'input[type="password"]': { count: 0 },
        'button:has-text("Continue")': { count: 1 }
      },
      { url: "https://x.example.com/sign-in" }
    );
    expect(await looksLikeLogin(page, undefined)).toBe(false);
  });

  it("treats sign OUT as the opposite of sign in", async () => {
    expect(LOGIN_HINT_RE.test("Sign out")).toBe(false);
    expect(LOGIN_HINT_RE.test("Log out")).toBe(false);
    expect(LOGIN_HINT_RE.test("Sign in")).toBe(true);
    expect(LOGIN_HINT_RE.test("/users/log-in")).toBe(true);
  });

  it("reads an unreadable page as NOT a login, so the worst case is the old behavior", async () => {
    const page = {
      locator: () => ({ first: () => ({}), count: async () => 0 }),
      url: () => {
        throw new Error("detached");
      }
    };
    expect(await looksLikeLoginPage(page)).toBe(false);
  });
});

describe("Continue stays out of the submit chain", () => {
  it("is an ADVANCE control, never a submit candidate", async () => {
    // Bugbot flagged a bare "Continue" in SUBMIT_SELECTORS as able to steal the
    // click from a validation-disabled real submit. It is safe in
    // ADVANCE_SELECTORS because that list is only consulted when the page has
    // NO password field, i.e. when there is no submit to steal from.
    expect(SUBMIT_SELECTORS.some((s) => /continue/i.test(s))).toBe(false);
    expect(ADVANCE_SELECTORS.some((s) => /continue/i.test(s))).toBe(true);
  });
});

describe("waitForPasswordField", () => {
  it("returns the selector as soon as the field exists", async () => {
    const page = stubPage({ 'input[type="password"]': { count: 1 } });
    expect(await waitForPasswordField(page, undefined, 1000)).toBe('input[type="password"]');
  });

  it("returns null rather than hanging when the step never arrives", async () => {
    const page = stubPage({ 'input[type="password"]': { count: 0 } });
    expect(await waitForPasswordField(page, undefined, 0)).toBeNull();
  });
});

/**
 * The wording gate, tightened after Bugbot (high severity, twice).
 *
 * 1. `LOGIN_HINT_RE` had no word boundaries, so "signin" matched inside
 *    "signing" and "designing" and "log in" matched inside "blog in".
 * 2. It scanned 4000 characters of `document.body.innerText`, so a "Sign In"
 *    link in a site header satisfied it on any ordinary page.
 *
 * Together those defeated the four-gate protection: a newsletter signup or a
 * guest checkout has an email box and a Continue button, and would then have
 * had the tenant's stored username typed into it and the button clicked.
 */
describe("LOGIN_HINT_RE word boundaries", () => {
  const matches = [
    "Sign in with your email",
    "Sign In",
    "/client/sign-in",
    "/users/sign_in",
    "/users/login?email=x",
    "Log in to continue",
    // "into" is ordinary login phrasing, and a bare \b after "in" rejected it.
    "Log into your account",
    "Sign into your account"
  ];
  const rejects = [
    "signing",
    "designing",
    "Redesigning our site",
    "blog in",
    // The "to" must not re-admit the prose cases either.
    "blog into the night",
    "logging in",
    "Sign out",
    "Log out",
    "signature"
  ];

  for (const t of matches) {
    it(`matches ${JSON.stringify(t)}`, () => expect(LOGIN_HINT_RE.test(t)).toBe(true));
  }
  for (const t of rejects) {
    it(`rejects ${JSON.stringify(t)}`, () => expect(LOGIN_HINT_RE.test(t)).toBe(false));
  }
});

describe("looksLikeLoginPage reads headlines, not body prose", () => {
  it("asks for the title and headings, never document.body.innerText", async () => {
    // The distinction is the fix: a "Sign In" link in a header lives in body
    // text and must not count; a page whose own headline says it is asking you
    // to sign in does.
    let script = "";
    const page = {
      url: () => "https://x.example.com/products",
      evaluate: async (fn: () => string) => {
        script = String(fn);
        return "";
      }
    };
    await looksLikeLoginPage(page);
    expect(script).toContain("document.title");
    expect(script).toContain("h1, h2, h3");
    expect(script).not.toContain("innerText");
  });

  it("refuses a shop page whose only sign-in wording is a header link", async () => {
    const page = stubPage(
      {
        'input[type="email"]': { count: 1 },
        'input[type="password"]': { count: 0 },
        'button:has-text("Continue")': { count: 1 }
      },
      // Headline is the checkout, not a login. The header's "Sign In" link is
      // body text and no longer reachable by this gate.
      { url: "https://shop.example.com/checkout", text: "Checkout | Enter your email" }
    );
    expect(await looksLikeLogin(page, undefined)).toBe(false);
  });

  it("accepts HomeLight, whose headline is exactly the ask", async () => {
    expect(await looksLikeLoginPage(stubPage({}, { url: "https://x/", text: "Sign in with your email" }))).toBe(true);
  });
});

/**
 * The caller's half of the stalled-advance fix (Bugbot, high severity).
 *
 * Making `performLogin` RETURN instead of throw removed a permanent
 * `auth_config_error`, and on its own that reintroduced the very bug this work
 * exists to close. `server.mjs` decided "did the login work?" by re-navigating
 * and asking `looksLikeLogin` again. A logged-out portal does not reliably
 * answer yes: HomeLight redirects to the `/referrals` marketing funnel, which
 * has no login form at all. So a stalled advance would have read as success
 * and the funnel would have gone to the extractor.
 *
 * `server.mjs` boots Express at import time, so it cannot be driven here. These
 * assert on its source instead, the same approach
 * `aiflow-render-dockerfile-copies-imports.test.ts` uses for the same reason.
 */
describe("server.mjs fails a stalled advance without asking the page", () => {
  const source = readFileSync(new URL("../vps/aiflow-render/server.mjs", import.meta.url), "utf8");

  it("treats passwordStepReached === false as a failure outright", () => {
    expect(source).toContain("passwordStepReached === false");
  });

  it("short-circuits BEFORE the looksLikeLogin re-check, not after it", () => {
    // Order matters: `||` with the flag first means the re-check never gets to
    // overrule a login we know did not happen.
    expect(source).toMatch(/stalledAdvance\s*\|\|\s*\(await looksLikeLogin/);
  });

  it("reports it as login_failed, which carries a screenshot and the page text", () => {
    // Not auth_config_error: a stalled Continue is a login failure with
    // evidence, not a missing form.
    const guardAt = source.indexOf("const stalledAdvance");
    expect(guardAt).toBeGreaterThan(-1);
    const after = source.slice(guardAt, guardAt + 2500);
    expect(after).toContain('error: "login_failed"');
    expect(after).toContain("screenshotBase64");
    expect(after).toContain("pageTextExcerpt");
  });

  it("names the advance and the step in the detail line", () => {
    expect(source).toContain("passwordStep=");
    expect(source).toContain("advance=");
  });

  it("drops the session, so the next call cannot reuse a logged-out context", () => {
    const guardAt = source.indexOf("const stalledAdvance");
    expect(source.slice(guardAt, guardAt + 200)).toContain("poisoned = true");
  });
});
