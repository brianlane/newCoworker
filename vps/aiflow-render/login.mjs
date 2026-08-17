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
  'input[id*="user" i]'
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

/** First selector in `candidates` that matches an element on the page, else null. */
export async function firstSelector(page, candidates) {
  for (const sel of candidates) {
    if (!sel) continue;
    if (await page.locator(sel).count().catch(() => 0)) return sel;
  }
  return null;
}

/**
 * True only when the page looks like an actual login FORM: a password field AND
 * a username/email field. Requiring both avoids treating an authenticated page
 * that merely embeds a stray password input (a "change password" widget) as a
 * logout, which would otherwise trigger a pointless re-login loop.
 */
export async function looksLikeLogin(page, login) {
  const passSel = login?.passwordSelector ? [login.passwordSelector] : PASSWORD_SELECTORS;
  if ((await firstSelector(page, passSel)) === null) return false;
  const userSel = login?.usernameSelector ? [login.usernameSelector] : USERNAME_SELECTORS;
  return (await firstSelector(page, userSel)) !== null;
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
  const userSel = await firstSelector(page, [
    login?.usernameSelector,
    ...USERNAME_SELECTORS,
    'input[type="text"]'
  ]);
  const passSel = await firstSelector(page, [login?.passwordSelector, ...PASSWORD_SELECTORS]);
  if (!userSel || !passSel) throw new Error("login_form_not_found");

  await page.fill(userSel, creds.username);
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
    selectors: { user: userSel, pass: passSel, submit: submit?.selector ?? null },
    submitEnabled: submit?.enabled ?? null,
    blurred,
    clickError: null
  };

  if (!submit) {
    // No control at all: fall back to submitting the form natively. This only
    // works on a real <form>, which is why it is the fallback and not the path.
    try {
      await page.locator(passSel).first().press("Enter");
    } catch (e) {
      diagnostics.clickError = `enter_fallback: ${String(e?.message ?? e)}`;
    }
  } else {
    try {
      await page.locator(submit.selector).first().click({ timeout: LOGIN_CLICK_TIMEOUT_MS });
    } catch (e) {
      // Keep the reason. This is the line whose `.catch(() => {})` hid the
      // Clever failure for a day.
      diagnostics.clickError = String(e?.message ?? e).slice(0, 200);
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
