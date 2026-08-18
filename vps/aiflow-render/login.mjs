/**
 * LOGIN engine for the AiFlow render service.
 *
 * Split out of server.mjs for the same reason ACTION mode was
 * (`actions.mjs`): everything here takes a Playwright `page` as a parameter and
 * touches no module-level browser state, so `tests/aiflow-render-login.test.ts`
 * can drive it with a stub page instead of booting Express and Chromium.
 * server.mjs still owns the HTTP surface, the browser pool and the decision of
 * WHEN to log in; this file owns "fill the form and submit it".
 *
 * The contract server.mjs depends on:
 *   looksLikeLogin(page, login)          -> boolean
 *   performLogin(page, creds, login)     -> diagnostics object (never throws for
 *                                           a click that did not land)
 *
 * ---------------------------------------------------------------------------
 * THE INCIDENT THIS IS BUILT AROUND (Clever, 2026-08-17)
 *
 * Amy Laidlaw's stored Clever credentials were correct and worked in a normal
 * browser, and every attempt through this service returned `login_failed`.
 * Clever's submit control is:
 *
 *   <button type="button" class="button button--primary button--disabled ..."
 *           disabled="" data-testid="Button">Log In</button>
 *
 * Three separate defects in the old routine, each sufficient on its own:
 *
 *   1. The submit chain led with `button[type="submit"]` and
 *      `input[type="submit"]`. This button is `type="button"`, so neither could
 *      match, and because it is not a submit button there is no native form
 *      submission for the `press("Enter")` fallback to trigger either.
 *   2. Candidate selection asked only `.count()`, which counts DISABLED
 *      elements. The control ships disabled and is enabled by the form's own
 *      validation, so we selected a control that could not be clicked. This is
 *      the same visible-versus-actionable gap that caused the Aug 4 2026 Clever
 *      accept incident in actions.mjs, in a different file.
 *   3. The click was written `.click().catch(() => {})`. A click that times out
 *      on a disabled control therefore raised nothing at all, so the one fact
 *      that explained the failure was discarded, and the caller reported a bare
 *      `login_failed` with no reason.
 *
 * And the reason a validation-gated button never enabled for us: `page.fill()`
 * sets the value and fires an `input` event but never BLURS the field. Forms
 * that validate on blur (the common React pattern behind a `--disabled` submit)
 * therefore never ran validation. A human tabbing between fields always does.
 * ---------------------------------------------------------------------------
 */

/** How long a submit click waits for the control to become actionable. */
export const LOGIN_CLICK_TIMEOUT_MS = Number(
  process.env.AIFLOW_LOGIN_CLICK_TIMEOUT_MS ?? 10_000
);
/** Bound on the post-blur settle, so validation can run before we look. */
export const LOGIN_SETTLE_MS = Number(process.env.AIFLOW_LOGIN_SETTLE_MS ?? 750);

export const USERNAME_SELECTORS = [
  'input[type="email"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
  'input[name*="email" i]',
  'input[name*="login" i]',
  'input[name*="user" i]',
  'input[id*="email" i]',
  'input[id*="user" i]',
  // LAST RESORT, and the position is the point. A placeholder is the only
  // handle on a field that ships with no type, name, id or autocomplete
  // (HomeLight's email box), but it is also the weakest signal on the list: a
  // newsletter or search box whose placeholder mentions email would otherwise
  // outrank a real username field and receive the typed credentials.
  // `firstSelector` returns the FIRST match, so ordering is the whole guard.
  // Kept last in EMAIL_FIRST_SELECTORS for the same reason.
  'input[placeholder*="email" i]'
];

export const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete="current-password"]'
];

/**
 * Submit candidates, most specific first.
 *
 * `:has-text()` is a case-insensitive SUBSTRING match and does not care about
 * the button's `type`, which is what lets these reach Clever's `type="button"`
 * control. They deliberately sit AFTER the native submit selectors so an
 * ordinary form still takes the ordinary path.
 */
export const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Log in")',
  'button:has-text("Sign in")',
  'button:has-text("Login")',
  // Deliberately NOT a bare "Continue". It is the single most common label on
  // things that are not the submit control: SSO steps, cookie banners, and the
  // very modal HomeLight's text-claim path dismisses with
  // click_text_while_present("Continue"). Because resolveSubmit prefers an
  // ENABLED candidate, a page whose real submit is still validation-disabled
  // would hand the click to whichever Continue happened to be live.
  // actions.mjs flags the same string as unsafe for the same reason.
  '[role="button"]:has-text("Log in")',
  '[role="button"]:has-text("Sign in")'
];

/**
 * How long the email-first step waits for the password field to turn up after
 * the advance click. HomeLight NAVIGATES to a second URL, so this has to
 * outlast a page load, not just a re-render.
 */
export const LOGIN_ADVANCE_TIMEOUT_MS = Number(
  process.env.AIFLOW_LOGIN_ADVANCE_TIMEOUT_MS ?? 10_000
);
/** Gap between re-checks while waiting for the password step to mount. */
export const LOGIN_ADVANCE_POLL_MS = Number(process.env.AIFLOW_LOGIN_ADVANCE_POLL_MS ?? 250);
/**
 * Shortened wait when the advance click itself threw. Long enough to cover a
 * click that timed out on actionability after already landing, short enough
 * that a genuinely stuck step fails in a second rather than ten.
 */
export const LOGIN_ADVANCE_GRACE_MS = Number(
  process.env.AIFLOW_LOGIN_ADVANCE_GRACE_MS ?? 1_000
);

/**
 * Controls that advance an EMAIL-FIRST login to its password step.
 *
 * "Continue" is deliberately excluded from SUBMIT_SELECTORS because it is the
 * most common label on things that are not a submit control, and resolveSubmit
 * prefers an enabled candidate, so a live Continue could steal the click from a
 * validation-disabled real submit. None of that applies here: this list is only
 * ever consulted when the page has an email field and NO password field, which
 * is to say when there is no submit control to steal from. The two uses stay
 * separate on purpose.
 */
export const ADVANCE_SELECTORS = [
  'button:has-text("Continue")',
  'button:has-text("Next")',
  '[role="button"]:has-text("Continue")',
  // HomeLight's Continue is an ANCHOR inside the email form, with no href, no
  // role and no type. Nothing above can reach it:
  //   <form class="email-field-form">
  //     <input type="text" placeholder="Enter your email" class="email-field-input">
  //     <a class="button email-submit">Continue</a>
  //   </form>
  // Scoped to a form first, because an anchor labelled "Continue" is common
  // enough in page furniture that the unscoped version belongs last.
  'form a:has-text("Continue")',
  'form a:has-text("Next")',
  'button[type="submit"]',
  'input[type="submit"]',
  'a:has-text("Continue")'
];

/**
 * Username fields specific enough to anchor an email-first login on.
 *
 * The looser USERNAME_SELECTORS (`input[name*="user" i]` and friends) exist to
 * find the field once we already know the page is a login form, because a
 * password field next to it settles that. On the email-first step there is no
 * password field to corroborate, so a loose match plus any "Continue" button
 * would let an ordinary signup or search page be mistaken for a login.
 */
export const EMAIL_FIRST_SELECTORS = [
  'input[type="email"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
  // HomeLight ships `<input type="text" placeholder="Enter your email">` with
  // no name, no id and no autocomplete, so the placeholder a person reads is
  // the ONLY thing identifying the field. Specific enough to belong here: a
  // box asking for an email is asking for an email. The other three gates (no
  // password field, an advance control, and a headline that says sign in) are
  // what stop a newsletter box from qualifying.
  'input[placeholder*="email" i]'
];

/**
 * Words that only appear on a page asking you to authenticate.
 *
 * The word boundaries are load-bearing. Without them "signin" matches inside
 * "signing" and "designing", and "log in" matches inside "blog in", so any
 * page carrying that prose would satisfy the wording gate.
 *
 * The optional "to" is equally load-bearing in the other direction: "Log into
 * your account" and "Sign into your account" are ordinary login headlines, and
 * a bare `\b` after "in" rejects both because "into" continues the word. It
 * cannot re-admit the false positives, since none of "signing", "designing" or
 * "blog in" contains "into" at that position either.
 */
export const LOGIN_HINT_RE = /\b(?:sign|log)[\s._-]?in(?:to)?\b/i;

/** First selector in `candidates` that matches an element on the page, else null. */
export async function firstSelector(page, candidates) {
  for (const sel of candidates) {
    if (!sel) continue;
    if (await page.locator(sel).count().catch(() => 0)) return sel;
  }
  return null;
}

/**
 * Does the visible page (or its URL) say it wants you to authenticate?
 *
 * Only consulted for the email-first step, where there is no password field to
 * settle the question. "Sign out" and "Log out" deliberately do not match.
 * Best-effort: a page that cannot be read is treated as NOT a login, so the
 * worst case is the old behavior rather than a spurious login attempt.
 */
export async function looksLikeLoginPage(page) {
  try {
    if (typeof page.url === "function" && LOGIN_HINT_RE.test(String(page.url() ?? ""))) {
      return true;
    }
  } catch {
    /* fall through to the headline check */
  }
  try {
    // Deliberately the TITLE and HEADINGS, not `document.body.innerText`.
    // Scanning body prose means a "Sign In" link in a site header, or a footer,
    // satisfies the gate on any ordinary page that happens to carry an email
    // box and a Continue button: a newsletter signup or a guest checkout. A
    // page whose own headline says "Sign in with your email" (HomeLight's does)
    // is actually asking you to authenticate.
    const headline = await page.evaluate?.(() =>
      [document.title ?? "", ...Array.from(document.querySelectorAll("h1, h2, h3"), (h) => h.textContent ?? "")]
        .join(" \n ")
    );
    return LOGIN_HINT_RE.test(String(headline ?? "").slice(0, 2000));
  } catch {
    return false;
  }
}

/**
 * True when the page looks like a login FORM.
 *
 * Two shapes count:
 *
 *  1. A password field AND a username/email field, together on one page.
 *     Requiring both avoids treating an authenticated page that merely embeds a
 *     stray password input (a "change password" widget) as a logout, which
 *     would otherwise trigger a pointless re-login loop.
 *
 *  2. EMAIL-FIRST: an email field, no password field, an advance control, and a
 *     page that says it wants you to sign in. Added 2026-08-18 because
 *     HomeLight is exactly this and the single-page test could not see it:
 *     `homelight.com/client/sign-in` takes only the email, Continue hands off
 *     to `homelight.com/users/login?email=...`, and the password field lives
 *     there. Shape 1 was false on both pages, so no login was ever ATTEMPTED
 *     and every HomeLight browse returned whatever logged-out page it landed
 *     on as a successful read. That is worse than a failure: a stale referral
 *     link fed a marketing funnel straight into extraction.
 */
export async function looksLikeLogin(page, login) {
  const userSel = await firstSelector(
    page,
    login?.usernameSelector ? [login.usernameSelector] : USERNAME_SELECTORS
  );
  if (!userSel) return false;

  const passSel = await firstSelector(
    page,
    login?.passwordSelector ? [login.passwordSelector] : PASSWORD_SELECTORS
  );
  if (passSel) return true;

  // Email-first: every gate below has to hold, because there is no password
  // field corroborating that this is a login at all.
  const emailSel = await firstSelector(
    page,
    login?.usernameSelector ? [login.usernameSelector] : EMAIL_FIRST_SELECTORS
  );
  if (!emailSel) return false;
  if (!(await firstSelector(page, [login?.advanceSelector, ...ADVANCE_SELECTORS]))) return false;
  return await looksLikeLoginPage(page);
}

/**
 * Poll for the password field to appear after the advance click. Returns its
 * selector, or null on timeout. Polls rather than using `waitForSelector`
 * because the field can arrive by NAVIGATION or by re-render, and we do not
 * know which portal does which.
 */
export async function waitForPasswordField(page, login, timeoutMs = LOGIN_ADVANCE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sel = await firstSelector(page, [login?.passwordSelector, ...PASSWORD_SELECTORS]);
    if (sel) return sel;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout?.(LOGIN_ADVANCE_POLL_MS);
  }
}

/**
 * Pick the submit control, preferring one that can actually take a click.
 *
 * Returns `{ selector, enabled }` or null. `enabled: false` is NOT a failure:
 * a validation-gated button is routinely disabled for a tick after blur, and
 * Playwright's `click()` waits for actionability. Reporting the flag is what
 * lets `login_failed` say "the submit control never became enabled" instead of
 * saying nothing.
 */
export async function resolveSubmit(page, login) {
  const candidates = [login?.submitSelector, ...SUBMIT_SELECTORS];
  let firstPresent = null;
  for (const sel of candidates) {
    if (!sel) continue;
    if (!(await page.locator(sel).count().catch(() => 0))) continue;
    if (!firstPresent) firstPresent = sel;
    const enabled = await page
      .locator(sel)
      .first()
      .isEnabled()
      .catch(() => false);
    if (enabled) return { selector: sel, enabled: true };
  }
  return firstPresent ? { selector: firstPresent, enabled: false } : null;
}

/**
 * Fill the credentials and submit.
 *
 * THROWS only when the form itself cannot be found, which is a genuine
 * permanent setup error the caller reports as `auth_config_error`. A submit
 * that does not land is returned as diagnostics rather than thrown, on purpose:
 * the caller re-navigates and re-checks whether we are logged in, and that
 * second check is the authority. Throwing here would turn a slow page into a
 * PERMANENT run failure, which is the opposite of what a transient click
 * timeout deserves.
 */
export async function performLogin(page, creds, login) {
  const findUser = () =>
    firstSelector(page, [login?.usernameSelector, ...USERNAME_SELECTORS, 'input[type="text"]']);

  let userSel = await findUser();
  let passSel = await firstSelector(page, [login?.passwordSelector, ...PASSWORD_SELECTORS]);
  let advanceSel = null;
  let advanceError = null;

  // EMAIL-FIRST portals (HomeLight): the password field is on the NEXT page.
  // Type the email, advance, and wait for it. Only entered when the page has a
  // username field and no password field, so this can never intercept an
  // ordinary one-page form.
  if (userSel && !passSel) {
    advanceSel = await firstSelector(page, [login?.advanceSelector, ...ADVANCE_SELECTORS]);
    if (advanceSel) {
      await page.fill(userSel, creds.username);
      // Same validate-on-blur reason as the submit below: an email-first
      // Continue is routinely disabled until the field validates.
      try {
        await page.locator(userSel).first().blur();
      } catch {
        /* a form with no blur handler is unaffected */
      }
      await page.waitForTimeout?.(LOGIN_SETTLE_MS);
      try {
        await page.locator(advanceSel).first().click({ timeout: LOGIN_CLICK_TIMEOUT_MS });
      } catch (e) {
        // Keep it. A silent failure here looks identical to "this portal has no
        // password", which is the misreading that cost a day on HomeLight.
        advanceError = `advance: ${String(e?.message ?? e)}`.slice(0, 200);
      }
      // A click that threw almost certainly did not advance the page, so do not
      // spend the full budget waiting for a step that is not coming. Still wait
      // briefly: a click can time out on actionability AFTER it has landed.
      passSel = await waitForPasswordField(
        page,
        login,
        advanceError ? LOGIN_ADVANCE_GRACE_MS : (login?.advanceTimeoutMs ?? LOGIN_ADVANCE_TIMEOUT_MS)
      );
      // The second page usually pre-fills the email from the query string, but
      // re-resolve rather than assume: it may not carry the field at all.
      userSel = await findUser();
    }
  }

  if (!passSel) {
    if (advanceSel) {
      // We DID find a login and DID try to advance it; the password step just
      // never arrived. Returning beats throwing, and the difference is not
      // cosmetic: the caller maps a throw to `auth_config_error`, which the
      // worker treats as PERMANENT, with no screenshot and no reason. A slow
      // Continue would therefore kill the run outright and tell nobody why,
      // which is exactly what this module's own header warns against. Hand the
      // reason back instead and let the caller's re-check be the authority: it
      // re-navigates, still sees a login page, and reports `login_failed` with
      // the detail, the page text and a screenshot.
      return {
        selectors: { user: userSel, pass: null, submit: null, advance: advanceSel },
        steps: 2,
        passwordStepReached: false,
        submitEnabled: null,
        blurred: false,
        clickError: advanceError ?? "password step never appeared after the advance click"
      };
    }
    throw new Error("login_form_not_found");
  }
  // After an email-first advance the username field is optional (the second
  // page may carry only the password); on a one-page form it is not.
  if (!userSel && !advanceSel) throw new Error("login_form_not_found");

  if (userSel) await page.fill(userSel, creds.username);
  await page.fill(passSel, creds.password);

  // Blur the last field so validate-on-blur forms actually validate and enable
  // their submit button. Best-effort: a form with no blur handler is unaffected,
  // and a page that cannot blur must not fail the login.
  let blurred = false;
  try {
    await page.locator(passSel).first().blur();
    blurred = true;
  } catch {
    blurred = false;
  }
  await page.waitForTimeout?.(LOGIN_SETTLE_MS);

  const submit = await resolveSubmit(page, login);
  // Selectors are grouped rather than spelled out as `passwordSelector: ...`,
  // which a generic-password scanner reads as a credential assignment even
  // though the value is a CSS selector. No secret belongs in this object: it is
  // returned to the caller and serialized into `login_failed`, so it carries
  // WHICH field was used and never WHAT was typed into it.
  const diagnostics = {
    selectors: {
      user: userSel,
      pass: passSel,
      submit: submit?.selector ?? null,
      advance: advanceSel
    },
    // 2 means the portal asked for the email first and the password on a second
    // page. Worth reporting: it is the difference between "wrong password" and
    // "we never reached the password step".
    steps: advanceSel ? 2 : 1,
    passwordStepReached: true,
    submitEnabled: submit?.enabled ?? null,
    blurred,
    clickError: advanceError
  };

  if (!submit) {
    // No control at all: fall back to submitting the form natively. This only
    // works on a real <form>, which is why it is the fallback and not the path.
    try {
      await page.locator(passSel).first().press("Enter");
    } catch (e) {
      diagnostics.clickError = [diagnostics.clickError, `enter_fallback: ${String(e?.message ?? e)}`]
        .filter(Boolean)
        .join("; ");
    }
  } else {
    try {
      await page.locator(submit.selector).first().click({ timeout: LOGIN_CLICK_TIMEOUT_MS });
    } catch (e) {
      // Keep the reason. This is the line whose `.catch(() => {})` hid the
      // Clever failure for a day.
      diagnostics.clickError = [diagnostics.clickError, String(e?.message ?? e).slice(0, 200)]
        .filter(Boolean)
        .join("; ");
      // A disabled-forever button still deserves the native attempt.
      try {
        await page.locator(passSel).first().press("Enter");
      } catch {
        /* the click error above is the one worth reporting */
      }
    }
  }
  return diagnostics;
}
