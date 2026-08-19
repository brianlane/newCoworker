/**
 * ACTION mode engine for the AiFlow render service.
 *
 * Split out of server.mjs so it can be exercised by `tests/aiflow-render-actions.test.ts`
 * without booting Express or Chromium: everything here takes a Playwright `page`
 * as a parameter and never touches module-level browser state. server.mjs owns
 * the HTTP surface, the browser pool, login, and EXTRACT mode; this file owns
 * "run the owner-authored click/fill sequence".
 *
 * The contract server.mjs depends on:
 *   parseActions(raw)         -> normalized actions array, or null when malformed
 *   performActions(page, a)   -> { completed } | { completed, error }
 *   condenseError(msg)        -> bounded error string that keeps the reason
 */

// Per-navigation timeout. Also the ceiling on the post-action network-quiet wait.
export const NAV_TIMEOUT_MS = Number(process.env.AIFLOW_RENDER_TIMEOUT_MS ?? 30000);

// ACTION mode: per-action click/fill timeout and a hard cap on sequence length
// (mirrors the worker-side schema cap so a hand-crafted request can't loop).
export const ACTION_TIMEOUT_MS = Number(process.env.AIFLOW_ACTION_TIMEOUT_MS ?? 10_000);
export const MAX_ACTIONS = 15;
// Upper bound on click_text_while_present iterations so a perpetually-present
// target (or a re-rendering label) can never spin forever.
export const MAX_WHILE_PRESENT_CLICKS = Number(process.env.AIFLOW_MAX_WHILE_PRESENT_CLICKS ?? 10);
// Shorter per-probe timeout for the "can the target still take a click?" check:
// once the button is gone (or has gone inert) we want to fall through quickly,
// not wait the full ACTION_TIMEOUT_MS for a locator that will never resolve.
export const WHILE_PRESENT_PROBE_MS = Number(process.env.AIFLOW_WHILE_PRESENT_PROBE_MS ?? 2_000);
/**
 * Hard cap on forEachLink list items so one request can't enumerate an
 * unbounded page of links and run the action sequence hundreds of times.
 *
 * Lowered 25 -> 6 on 2026-08-17, because 25 was never deliverable. The WHOLE
 * loop runs inside a SINGLE HTTP response, and that response crosses a
 * Cloudflare Tunnel whose ingress rules carry no `originRequest` block
 * (`src/lib/cloudflare/tunnel.ts` writes hostname and service, nothing else),
 * so it inherits Cloudflare's default ~100s 524 timeout. Measured on Amy
 * Laidlaw's completed Clever sweeps, cost is about 5s fixed plus 13s per lead:
 *
 *   items 1 -> 20.0s | 2 -> 32.0s | 3 -> 45.4s | 4 -> 59.0s | 5 -> 60.0s
 *
 * so 25 items is ~330s, more than three times the edge budget. The old cap was
 * a generous fiction sitting behind a ceiling nobody had hit yet, only because
 * the largest sweep the fleet had ever run was 5 leads at 60s. Six items is
 * ~83s, which fits with headroom.
 *
 * A 524 is strictly worse than a truncation: the worker classifies a non-2xx
 * from the edge as transient and RETRIES the step, so a timed-out pass re-runs
 * its action sequence on every row it already submitted. Truncation, by
 * contrast, is reported honestly (see capForEachList: the skipped tail counts
 * as `failed`, carries an explicit error, AND is reported as `remaining`).
 *
 * This cap is the PER-PASS chunk size, not the coverage limit. A backlog
 * larger than one pass is drained by the ai-flow-worker chaining passes: it
 * reads `remaining` off the response, defers the run, and re-enters the same
 * step for the next slice (updated cards leave the portal's "Needs Action"
 * list, so re-listing yields only what is still owed). Raising this number is
 * still the wrong fix for a big backlog: it just moves the failure from
 * "honestly chunked" to "timed out halfway and then did it twice".
 */
export const MAX_FOREACH_ITEMS = Number(process.env.AIFLOW_MAX_FOREACH_ITEMS ?? 6);

/**
 * Slice a forEachLink href list to the per-pass cap, reporting the cut.
 *
 * Pure and exported so the truncation arithmetic the worker's chaining
 * depends on is pinned by tests: `remaining` is what tells the worker another
 * pass is owed, and `capNote` is the human-readable error the skipped tail
 * shows up as (kept inside `failed` for older workers that predate chaining).
 */
export function capForEachList(hrefs) {
  const total = hrefs.length;
  const kept = hrefs.slice(0, MAX_FOREACH_ITEMS);
  const remaining = total - kept.length;
  return {
    kept,
    remaining,
    capNote:
      remaining > 0
        ? `forEachLink matched ${total} items; capped at ${MAX_FOREACH_ITEMS}, ${remaining} not processed`
        : null
  };
}
/**
 * How long a SINGLE `click_text` waits for its control to turn up before
 * concluding the page does not have one.
 *
 * Every match strategy below asks `.count()`, which resolves against the DOM as
 * it stands right now. On a client-rendered portal that is a race: the shell
 * paints, the settle wait sees the network go quiet, and the button the action
 * is looking for is mounted a moment later by hydration. The action then failed
 * with "no matching control on the page" while the saved page artifact shows
 * the control plainly there, which is what made the failure so confusing to
 * diagnose. Amy Laidlaw's Clever accept step hit this on 2026-08-06: the run
 * dead-lettered at step 1 with the Accept button present in its own artifact.
 *
 * Deliberately NOT applied to `click_text_while_present`, where zero matches is
 * how the loop knows it is finished.
 */
export const CLICK_TEXT_APPEAR_MS = Number(process.env.AIFLOW_CLICK_TEXT_APPEAR_MS ?? 5_000);
/**
 * Total time a DRY RUN may spend waiting for controls to mount, across the
 * whole sequence. See checkActions for why this is shared rather than
 * per-action: 15 absent actions at CLICK_TEXT_APPEAR_MS each would not fit
 * inside the tunnel's ~100s response ceiling.
 */
export const CHECK_TOTAL_APPEAR_MS = Number(process.env.AIFLOW_CHECK_TOTAL_APPEAR_MS ?? 30_000);
/** Gap between re-checks while waiting for a control to mount. */
export const CLICK_TEXT_APPEAR_POLL_MS = Number(
  process.env.AIFLOW_CLICK_TEXT_APPEAR_POLL_MS ?? 250
);
/**
 * How long a post-action expectation (`expectText`) waits for the page to show
 * the expected marker before the step is reported as failed.
 *
 * Why this exists: on 2026-08-16 Amy's HomeLight `claim_click` resolved the
 * real claim button, Playwright delivered the click, `actionsCompleted` said 1,
 * and HomeLight's backend never registered the claim (Telnyx shows no callback
 * until a human clicked the same button by hand). A dispatched click is not an
 * applied click on a hydrating SPA, so a consequential action needs to assert
 * the page's AFTER state, not just that no exception was thrown.
 */
export const EXPECT_TEXT_TIMEOUT_MS = Number(process.env.AIFLOW_EXPECT_TEXT_TIMEOUT_MS ?? 10_000);

/**
 * Wait for `text` to appear (case-insensitive) in the page's VISIBLE text.
 * Visible text on purpose, not raw HTML: the expectation asserts what a person
 * would now see ("We're calling you at ..."), and matching markup would pass on
 * templates that never rendered. Returns true when the marker appeared, false
 * on timeout; a blank marker is vacuously true. Never throws.
 */
export async function waitForExpectedText(page, text, timeoutMs = EXPECT_TEXT_TIMEOUT_MS) {
  const needle = String(text ?? "")
    .trim()
    .toLowerCase();
  if (!needle) return true;
  try {
    await page.waitForFunction(
      (n) => (document.body?.innerText ?? "").toLowerCase().includes(n),
      needle,
      { timeout: timeoutMs }
    );
    return true;
  } catch {
    return false;
  }
}
export const ACTION_KINDS = new Set([
  "click_text",
  "click_selector",
  "fill_selector",
  "fill_placeholder",
  "click_text_while_present",
  "click_role",
  "select_option"
]);

// Kinds whose `value` is REQUIRED (a fill string, an ARIA name, an option value).
// fill_placeholder is intentionally NOT here: clearing a field with "" is valid.
const ACTION_KINDS_REQUIRING_VALUE = new Set(["click_role", "select_option"]);

/**
 * Bound on the error text we hand back to the worker, which stores it in
 * `system_logs.message` and `ai_flow_runs.last_error` (2000 chars).
 *
 * This is NOT a plain head-slice, and the difference matters. A Playwright
 * actionability timeout puts the WHY at the END of its call log ("element is not
 * enabled", "<div> intercepts pointer events"), after a long "locator resolved
 * to <button ...>" dump. The old flat `.slice(0, 300)` cut the string exactly
 * where the reason begins, so a stored failure read
 * `locator resolved to <button type="button" data-testid="Button-primary" data-sentry`
 * and stopped. Keeping a head AND a tail means the next person reading a failed
 * run gets both the locator and the reason.
 */
export const ERROR_DETAIL_MAX = 600;
const ERROR_DETAIL_TAIL = 200;

export function condenseError(msg) {
  const s = String(msg ?? "");
  if (s.length <= ERROR_DETAIL_MAX) return s;
  const head = s.slice(0, ERROR_DETAIL_MAX - ERROR_DETAIL_TAIL - 3);
  return `${head}...${s.slice(-ERROR_DETAIL_TAIL)}`;
}

/** Normalize + validate the request's actions array, or null when malformed. */
export function parseActions(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ACTIONS) return null;
  const out = [];
  for (const a of raw) {
    const kind = String(a?.kind ?? "");
    const target = String(a?.target ?? "");
    const value = String(a?.value ?? "");
    if (!ACTION_KINDS.has(kind) || !target) return null;
    if (ACTION_KINDS_REQUIRING_VALUE.has(kind) && !value) return null;
    out.push({ kind, target, value });
  }
  return out;
}

/**
 * Resolve a "click this text" target to an actual control. The whole point is to
 * stop the matcher from latching onto descriptive body copy that merely contains
 * the word, e.g. a "click Accept" action hitting the subtitle "…then accept or
 * reject." or a "Next" wizard loop hitting the sentence "…on the next screen…".
 * (That Accept case is real: an already-claimed Clever Offers page has no Accept
 * button but its description says "…then accept or reject", and a loose
 * substring match happily "clicked" that sentence, so the step succeeded and the
 * worker's skipWhenText already-claimed guard never ran.)
 *
 * Substring matches therefore ONLY ever resolve to a real INTERACTIVE control,
 * by substring accessible name or substring text scoped to interactive elements,
 * so labels with trailing glyphs ("Next →", "Accept ✓") still match while
 * prose (<p>/<span>) never does. Returns null when no control matches; callers
 * fail the action (single click) or treat it as "step done" (while-present).
 *
 * Two modes:
 *   - `allowExactTextAnywhere: true` (single `click_text`): an element whose
 *     ENTIRE text is exactly the target may match even when it isn't a semantic
 *     control (legacy: clickable divs whose handlers aren't visible in the DOM).
 *   - `allowExactTextAnywhere: false` (`click_text_while_present`): exact-text
 *     matches must also land on an interactive element.
 *
 * Returns a Locator (callers .click()/.waitFor() it) or null.
 */
export async function resolveClickTarget(
  page,
  target,
  { allowExactTextAnywhere = true, appearTimeoutMs = CLICK_TEXT_APPEAR_MS } = {}
) {
  const deadline = Date.now() + Math.max(0, appearTimeoutMs);
  for (;;) {
    const hit = await resolveClickTargetOnce(page, target, { allowExactTextAnywhere });
    if (hit) return hit;
    // Only a SINGLE click waits. For the while-present loop zero matches is the
    // success condition, so waiting here would add this timeout to the end of
    // every loop rather than catching anything.
    if (!allowExactTextAnywhere || Date.now() >= deadline) return null;
    await page.waitForTimeout(CLICK_TEXT_APPEAR_POLL_MS);
  }
}

async function resolveClickTargetOnce(page, target, { allowExactTextAnywhere }) {
  // 1) A real control whose ACCESSIBLE NAME is exactly the target.
  const byRoleExact = page
    .getByRole("button", { name: target, exact: true })
    .or(page.getByRole("link", { name: target, exact: true }));
  if ((await byRoleExact.count()) > 0) return byRoleExact.first();

  // Interactive controls: text matches must land on one of these (except the
  // legacy exact-text-anywhere case), so a static node reading "Next" can't
  // drive a loop and prose containing the word can't be "clicked".
  const interactive = page.locator(
    'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], input[type="button"], input[type="submit"], [onclick]',
  );

  // 2) Exact visible text: anywhere for a single click, controls-only for the
  //    while-present loop.
  const byExactText = page.getByText(target, { exact: true });
  const byExactAllowed = allowExactTextAnywhere ? byExactText : byExactText.and(interactive);
  if ((await byExactAllowed.count()) > 0) return byExactAllowed.first();

  // 3) Control whose label CONTAINS the target (e.g. "Next →", "Next Page"):
  //    substring accessible name, or any interactive element whose text contains
  //    the target. `interactive` keeps this off sentences like "…next screen…".
  const byRoleSubstr = page
    .getByRole("button", { name: target })
    .or(page.getByRole("link", { name: target }));
  if ((await byRoleSubstr.count()) > 0) return byRoleSubstr.first();
  const bySubstrControl = page.getByText(target, { exact: false }).and(interactive);
  if ((await bySubstrControl.count()) > 0) return bySubstrControl.first();

  return null;
}

// Bound on how many STACKED blocking modals one dismissal pass will close
// (Clever stacks an announcement modal under a scroll-gated agreement modal).
export const MAX_OVERLAY_DISMISS_ROUNDS = Number(
  process.env.AIFLOW_MAX_OVERLAY_DISMISS_ROUNDS ?? 3
);

/**
 * The safelists that decide which control inside a blocking overlay may be
 * clicked. They live here, at module scope, for two reasons: they are the whole
 * security surface of the dismisser, and `page.evaluate` cannot call an outer
 * function, so passing their `source` into the page is what stops the browser
 * copy from drifting away from the copy under test.
 */
/** Dismissal by accessible name / exact text. */
export const CLOSE_NAME_RE = /^(close|dismiss|got it|no thanks|not now|maybe later|skip|x|×)$/i;
/** Agreement-style, only tried after every close-style candidate fails. */
export const AGREE_NAME_RE =
  /^(agree (and|&) (close|continue)|i understand|acknowledge|scroll to continue)$/i;
/**
 * Icon-only close buttons, which carry NO accessible name at all.
 *
 * HomeLight's "This client prefers texting" modal (Aug 2026) is the case that
 * forced this: its close control is
 *   <div role="button" data-test="modal__close-button">
 *     <svg aria-hidden="true" data-icon="times">
 * so `aria-label || textContent` is the EMPTY STRING, CLOSE_NAME_RE never
 * matched, `pick()` returned nothing, and the dismisser reported "no blocking
 * modal" while a full-screen modal sat over the page. The referral's claim
 * button was underneath it.
 *
 * Deliberately NOT solved by adding "continue" to the name list: that modal's
 * other button says "Continue", and a bare "Continue" on some other portal can
 * advance a consequential wizard rather than dismiss a layer. An X is an X.
 *
 * Both patterns are matched only when the control has NO accessible name, so a
 * labelled button always goes through the name lists above and can never be
 * caught by a stray class name.
 */
/** Attribute tokens that self-identify a close affordance (data-test, class, id, title). */
export const CLOSE_ATTR_RE = /(^|[^a-z])(close|dismiss)([^a-z]|$)/i;
/** `data-icon` values used for an X glyph (FontAwesome and friends). */
export const CLOSE_ICON_RE = /^(times|xmark|close|x|times-circle|circle-xmark)$/i;

/**
 * Interception recovery for ACTION mode: portals (e.g. Clever, July 2026) began
 * stacking full-viewport announcement / scroll-gated agreement modals over lead
 * pages, so every authored click times out, Playwright refuses to click an
 * element another layer covers ("Provide Update" under a "Clever Offers
 * Program" agreement modal + a "Service Areas" announcement modal).
 *
 * Find the topmost fixed, full-viewport element currently covering the
 * viewport center (the layer intercepting our pointer events) and click ONE
 * dismissal control inside it, repeating for stacked modals up to
 * MAX_OVERLAY_DISMISS_ROUNDS. Only SAFELISTED controls are ever clicked, in
 * this order (see CLOSE_NAME_RE / CLOSE_ATTR_RE / AGREE_NAME_RE):
 *   - close-style BY NAME: "Close" / "Dismiss" / "Got it" / "Not now" /
 *     "Skip" / "×" (accessible name or exact text), else
 *   - close-style BY ICON: a control with NO accessible name that carries an X
 *     glyph or a close/dismiss token in its own attributes. HomeLight's modal
 *     close is a div[role=button][data-test=modal__close-button] around an
 *     aria-hidden svg, so it has no name and the list above skipped it, else
 *   - agreement-style: "Agree and close" / "I understand" / "Acknowledge" /
 *     "Scroll to continue". When it's disabled behind a scroll gate, the
 *     modal's inner scrollers are scrolled to the bottom first and the button
 *     re-picked (Clever's "Scroll to continue" re-renders into an enabled
 *     "Agree and close").
 * Closing is tried before agreeing because closing commits to less.
 * Candidates must be <button>/[role="button"] INSIDE the overlay, never
 * anchors (navigation) and never consequential labels like "Accept"/"Submit"/
 * "OK", so a wizard dialog the actions opened on purpose can never be
 * advanced, only genuinely dismissable layers closed. EXTRACT mode never calls
 * this (reads don't need pointer events). Returns how many layers were
 * dismissed; 0 means "nothing here looked like a blocking modal".
 *
 * `protectTarget` is the CURRENT action's protect hint, the string identifying
 * the control we just failed to click (its text / CSS selector / ARIA name; see
 * performActions). When the topmost overlay CONTAINS that control, the overlay isn't a
 * layer covering our target, it IS the dialog hosting it (e.g. the Clever "We
 * Spoke" update modal whose own datepicker popup briefly intercepted the
 * "Submit Update" click). Closing it would delete the very button we're after
 * and turn a transient interception into a fatal "no matching control", so we
 * refuse to dismiss it and let the original error surface. Matching is
 * intentionally loose (CSS selector OR interactive-control substring text) so
 * it covers click_selector, click_text, and click_role hints alike.
 */
export async function dismissBlockingOverlays(page, protectTarget = "") {
  let dismissed = 0;
  for (let round = 0; round < MAX_OVERLAY_DISMISS_ROUNDS; round++) {
    let clicked = "";
    try {
      clicked = await page.evaluate(async ({ protect, cfg }) => {
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        };
        // The layer intercepting clicks is the LAST (topmost in DOM order)
        // fixed full-viewport element that owns the hit-test result at the
        // viewport center. pointer-events:none layers never win elementFromPoint,
        // so a non-intercepting banner can't be picked.
        const at = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        if (!at) return "";
        let overlay = null;
        for (const el of document.querySelectorAll("body *")) {
          if (!isVisible(el) || getComputedStyle(el).position !== "fixed") continue;
          const r = el.getBoundingClientRect();
          if (r.width < innerWidth * 0.85 || r.height < innerHeight * 0.85) continue;
          if (el === at || el.contains(at)) overlay = el;
        }
        if (!overlay) return "";
        // Never close the dialog that HOSTS the control we're trying to click,
        // dismissing it would remove our target (see docstring).
        if (protect) {
          let hostsTarget = false;
          try {
            hostsTarget = !!overlay.querySelector(protect);
          } catch {
            hostsTarget = false; // `protect` was action text, not a valid selector
          }
          if (!hostsTarget) {
            // Interactive controls only (buttons/links plus the ARIA widget
            // roles click_role targets, e.g. a datepicker's [role="option"]),
            // matching arbitrary prose would over-protect every text-bearing
            // modal.
            const want = protect.trim().toLowerCase();
            hostsTarget = [
              ...overlay.querySelectorAll(
                'button, a, [role="button"], [role="link"], [role="option"], ' +
                  '[role="menuitem"], [role="tab"], [role="radio"], [role="checkbox"]'
              )
            ].some((el) => (el.textContent || "").trim().toLowerCase().includes(want));
          }
          if (hostsTarget) return "__protected__";
        }
        const name = (el) => (el.getAttribute("aria-label") || el.textContent || "").trim();
        const buttons = () =>
          [...overlay.querySelectorAll('button, [role="button"]')].filter(isVisible);
        const CLOSE_RE = new RegExp(cfg.closeName, "i");
        const AGREE_RE = new RegExp(cfg.agreeName, "i");
        const CLOSE_ATTR = new RegExp(cfg.closeAttr, "i");
        const CLOSE_ICON = new RegExp(cfg.closeIcon, "i");
        // An icon-only close button (empty accessible name, X glyph or a
        // close/dismiss token in its own attributes). Only ever consulted when
        // the control has NO name, so a labelled button cannot be caught by a
        // stray class.
        const isIconClose = (el) => {
          if (name(el)) return false;
          const attrs = [
            el.getAttribute("data-test"),
            el.getAttribute("data-testid"),
            el.getAttribute("title"),
            el.getAttribute("class"),
            el.id
          ]
            .filter(Boolean)
            .join(" ");
          if (CLOSE_ATTR.test(attrs)) return true;
          const icon = el.querySelector("svg[data-icon]");
          return CLOSE_ICON.test(icon?.getAttribute("data-icon") ?? "");
        };
        const pick = () =>
          buttons().find((b) => CLOSE_RE.test(name(b))) ??
          buttons().find((b) => isIconClose(b)) ??
          buttons().find((b) => AGREE_RE.test(name(b)));
        let btn = pick();
        if (!btn) return "";
        if (btn.disabled) {
          // Scroll-gated agreement: the button enables (and may re-render with
          // a new label) only once the modal body has been scrolled to the
          // bottom. Scroll every scrollable descendant, give the framework a
          // beat to re-render, then re-pick.
          for (const el of overlay.querySelectorAll("*")) {
            if (el.scrollHeight > el.clientHeight + 5) el.scrollTop = el.scrollHeight;
          }
          await new Promise((resolve) => setTimeout(resolve, 600));
          btn = pick();
          if (!btn || btn.disabled) return "";
        }
        const desc = name(btn) || "(unlabeled close)";
        btn.click();
        return desc;
      }, {
        protect: protectTarget,
        // Patterns crossed into the page as sources, so the browser copy is
        // literally the module-level one the tests exercise.
        cfg: {
          closeName: CLOSE_NAME_RE.source,
          agreeName: AGREE_NAME_RE.source,
          closeAttr: CLOSE_ATTR_RE.source,
          closeIcon: CLOSE_ICON_RE.source
        }
      });
    } catch {
      break; // page navigated/closed mid-probe, nothing left to dismiss
    }
    // The topmost overlay is the dialog hosting our target, don't close it.
    if (clicked === "__protected__") break;
    if (!clicked) break;
    dismissed++;
    console.log(`[render] dismissed blocking overlay via "${clicked}"`);
    // Let the modal unmount (or the next stacked one surface) before re-probing.
    await page.waitForTimeout(500);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  }
  return dismissed;
}

/**
 * Run the ordered click/fill sequence. Stops at the FIRST failing action and
 * reports how far it got, so the worker can surface exactly which action broke
 * (a changed page is a permanent error, not a retry). After every action we
 * wait for network idle (best-effort) so a click that opens a dialog / posts a
 * form settles before the next action targets the new DOM.
 *
 * A failed action gets ONE retry when dismissBlockingOverlays actually closed
 * a full-viewport modal, the failure was then very likely interception, not a
 * changed page. A per-kind protect hint (the control's text / selector / ARIA
 * name) is passed through so the dismisser never closes the dialog that HOSTS
 * that control (which would delete the very control we're after). When nothing
 * was dismissed the original error is reported unchanged, so genuine
 * page-drift failures stay loud and permanent.
 */
export async function performActions(page, actions) {
  let completed = 0;
  for (const a of actions) {
    try {
      try {
        await runAction(page, a);
      } catch (firstErr) {
        // Protect hint: the string that identifies the control inside its host
        // dialog. For click_role the target is just the ARIA role ("option"),
        // the distinctive string is the accessible NAME in `value` (e.g.
        // "09:00"); every other kind identifies the control by `target` itself
        // (text, CSS selector, or placeholder).
        const protectHint = a.kind === "click_role" ? a.value ?? "" : a.target;
        if ((await dismissBlockingOverlays(page, protectHint)) === 0) throw firstErr;
        await runAction(page, a);
      }
      await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
      completed++;
    } catch (e) {
      return {
        completed,
        error: condenseError(`${a.kind} "${a.target}": ${String(e?.message ?? e)}`)
      };
    }
  }
  return { completed };
}

/**
 * Can this target take a click right now?
 *
 * Three states, because the two existing behaviors and the bug all live here:
 *   - "absent": no matching control, or it never became visible / detached
 *     mid-probe. Ends a while-present loop as SUCCESS (the page is past the
 *     step). Zero matches being success is load-bearing:
 *     scripts/oneshot/patch-clever-accept-followup.ts uses a target that never
 *     matches as a deliberate no-op "just load the page" action.
 *   - "ready": visible AND enabled, so a click has a real chance.
 *   - "blocked": on the page and visible, but not enabled inside the probe
 *     window.
 *
 * The old probe only asked "visible?", while the click it guarded demands full
 * Playwright actionability (visible AND enabled AND stable AND receiving
 * pointer events). That gap is the Aug 4 2026 Clever incident: a FINISHED
 * wizard leaves its primary button visible for a beat while disabled or
 * unmounting, the loop clicked it anyway, burned the full ACTION_TIMEOUT_MS,
 * and threw, so a referral that HAD been accepted came back as a dead-lettered
 * run and 19 downstream steps never ran.
 */
/**
 * The three-state verdict for a locator that has ALREADY been resolved:
 * "absent" (never became visible, or detached mid-probe), "ready" (visible and
 * enabled) or "blocked" (there, but not enabled inside the probe window).
 *
 * Split out of probeClickable so the dry run (checkActions) reaches the exact
 * same verdict the while-present loop acts on. A check that judged
 * actionability differently from the thing it predicts would be worse than no
 * check at all.
 */
async function probeLocator(loc) {
  try {
    await loc.waitFor({ state: "visible", timeout: WHILE_PRESENT_PROBE_MS });
  } catch {
    // Never became visible, or detached mid-probe. The old boolean probe drew
    // the same conclusion here, so this path is unchanged.
    return "absent";
  }
  try {
    if (await loc.isEnabled({ timeout: WHILE_PRESENT_PROBE_MS })) return "ready";
  } catch {
    return "absent";
  }
  return "blocked";
}

async function probeClickable(page, target) {
  const loc = await resolveClickTarget(page, target, { allowExactTextAnywhere: false });
  if (!loc) return { state: "absent", loc: null };
  const state = await probeLocator(loc);
  return state === "absent" ? { state, loc: null } : { state, loc };
}

/** Execute ONE parsed action (see performActions for retry/error semantics). */
export async function runAction(page, a, opts = {}) {
  if (a.kind === "click_text") {
    // Prefer a real button/link (or exact-text element); substring matches
    // resolve ONLY to interactive controls so body copy that merely
    // contains the word (e.g. "…then accept or reject.") can never be
    // "clicked" into a phantom success.
    const loc = await resolveClickTarget(page, a.target, {
      allowExactTextAnywhere: true,
      ...(typeof opts.appearTimeoutMs === "number"
        ? { appearTimeoutMs: opts.appearTimeoutMs }
        : {})
    });
    if (!loc) throw new Error("no matching control on the page");
    await loc.click({ timeout: ACTION_TIMEOUT_MS });
  } else if (a.kind === "click_text_while_present") {
    // Wizard-style "Next" loop: click the control as long as it can TAKE a
    // click, bounded by MAX_WHILE_PRESENT_CLICKS. Resolves ONLY to real
    // controls (no substring fallback) so it can't latch onto prose that
    // contains the word (e.g. "…on the next screen…").
    //
    // The loop ends on "absent" (page is past the step) or on "blocked" AFTER
    // at least one click landed, a wizard that advanced and then went inert is
    // a wizard that FINISHED. "blocked" with zero clicks landed is different:
    // nothing moved, so the page is genuinely stuck and we stay loud rather
    // than letting the next browse_extract read a half-completed page.
    let clicks = 0;
    let hit = await probeClickable(page, a.target);
    while (clicks < MAX_WHILE_PRESENT_CLICKS && hit.state === "ready") {
      try {
        await hit.loc.click({ timeout: ACTION_TIMEOUT_MS });
      } catch (e) {
        // Went unclickable between the probe and the click (unmounted, disabled
        // behind a submit, or a layer dropped over it). Same rule as "blocked".
        if (clicks === 0) throw e;
        console.log(
          `[render] while_present "${a.target}": stopped after ${clicks} click(s), ` +
            `target went unclickable: ${String(e?.message ?? e).slice(0, 120)}`
        );
        return;
      }
      await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
      clicks++;
      hit = await probeClickable(page, a.target);
    }
    if (hit.state === "blocked" && clicks === 0) {
      throw new Error(`"${a.target}" is on the page but never became clickable`);
    }
    // Hitting the cap while the target is still there means the wizard never
    // finished, fail so the worker doesn't extract from a half-completed page
    // (a changed/looping page is a permanent error).
    if (clicks >= MAX_WHILE_PRESENT_CLICKS && hit.state !== "absent") {
      throw new Error(`still present after ${MAX_WHILE_PRESENT_CLICKS} clicks`);
    }
    console.log(`[render] while_present "${a.target}": ${clicks} click(s), ended ${hit.state}`);
  } else if (a.kind === "click_selector") {
    await page.locator(a.target).first().click({ timeout: ACTION_TIMEOUT_MS });
  } else if (a.kind === "click_role") {
    // target = ARIA role, value = accessible name (e.g. a calendar day cell
    // "Choose Thursday, June 18th, 2026"). Name match is case-insensitive
    // substring so authors don't have to reproduce the exact label.
    await page
      .getByRole(a.target, { name: a.value, exact: false })
      .first()
      .click({ timeout: ACTION_TIMEOUT_MS });
  } else if (a.kind === "select_option") {
    // target = CSS selector for the <select>, value = option value OR label.
    await page
      .locator(a.target)
      .first()
      .selectOption({ label: a.value }, { timeout: ACTION_TIMEOUT_MS })
      .catch(() =>
        page.locator(a.target).first().selectOption(a.value, { timeout: ACTION_TIMEOUT_MS })
      );
  } else if (a.kind === "fill_selector") {
    await page.locator(a.target).first().fill(a.value, { timeout: ACTION_TIMEOUT_MS });
  } else {
    await page
      .getByPlaceholder(a.target, { exact: false })
      .first()
      .fill(a.value, { timeout: ACTION_TIMEOUT_MS });
  }
}

/**
 * DRY RUN: would each action find something to act on, on this page?
 *
 * Exists because until now the ONLY way to find out whether an owner-authored
 * sequence still matches a vendor's markup was to let it run on a live lead.
 * The dashboard's "Test with a contact" simulates browse steps (it echoes the
 * action list and never opens a browser), so a selector's first real test was
 * production, days later, silently.
 *
 * Resolves every action's target EXACTLY the way runAction would, then reports
 * what it found. It never clicks, types, chooses or navigates: no locator
 * returned here is acted on, so the heaviest thing a dry run does is the same
 * login the tenant's flows already perform many times a day.
 *
 * Per-action verdicts:
 *   "ready"          the control is there, visible and enabled
 *   "blocked"        on the page and visible, but not enabled in the probe window
 *   "absent"         nothing matched, or it never became visible
 *   "missing_option" a <select> matched but offers no such choice
 *
 * THE LIMIT, which callers must state plainly rather than paper over: this
 * judges the page AS LOADED. A sequence whose later steps only exist after an
 * earlier click (a wizard, a modal, a drawer) will report those as absent, and
 * that is not evidence they are wrong. Simulating the sequence would mean
 * performing it, which is the one thing a dry run must not do.
 */
export async function checkActions(page, actions, { totalAppearMs } = {}) {
  const budgetMs = typeof totalAppearMs === "number" ? totalAppearMs : CHECK_TOTAL_APPEAR_MS;
  const deadline = Date.now() + Math.max(0, budgetMs);
  const out = [];
  for (const a of actions) {
    // Share ONE appear budget across the sequence. Per-action patience is what
    // makes a verdict trustworthy, but only an ABSENT target ever waits it out,
    // so a badly broken 15-action sequence would spend 15 x
    // CLICK_TEXT_APPEAR_MS. That does not fit: the whole dry run is a single
    // HTTP response behind a Cloudflare Tunnel with the default ~100s 524
    // timeout (the same ceiling that forced MAX_FOREACH_ITEMS down from 25 to
    // 6), and a 524 would reach the owner as an unexplained failure of the
    // button that exists to explain failures.
    //
    // The first miss therefore gets the real timeout, which is the case that
    // matters (one selector went stale). Once the budget is spent, later
    // actions still get a full immediate resolution pass, so anything actually
    // present is still found; only the wait-for-it-to-mount grace is gone.
    const remaining = Math.max(0, deadline - Date.now());
    out.push(await checkAction(page, a, { appearTimeoutMs: remaining }));
  }
  return out;
}

/**
 * Locate ONE action's target without acting on it. Mirrors runAction's
 * resolution per kind; returns a Locator or null.
 *
 * `click_text` keeps the same appear timeout the real action uses rather than
 * a shorter one. An impatient check would report "not found" for a control the
 * real run resolves a moment later, and a false alarm on a working sequence is
 * the fastest way to make owners stop trusting the button. The cost is bounded:
 * only an action that is genuinely absent waits out the timeout, so a healthy
 * sequence returns fast and the slow case is the one being diagnosed.
 */
async function locateActionTarget(page, a, opts = {}) {
  if (a.kind === "click_text" || a.kind === "click_text_while_present") {
    return await resolveClickTarget(page, a.target, {
      allowExactTextAnywhere: a.kind === "click_text",
      ...(typeof opts.appearTimeoutMs === "number"
        ? { appearTimeoutMs: Math.min(opts.appearTimeoutMs, CLICK_TEXT_APPEAR_MS) }
        : {})
    });
  }
  if (a.kind === "click_role") {
    return page.getByRole(a.target, { name: a.value, exact: false }).first();
  }
  if (a.kind === "fill_placeholder") {
    return page.getByPlaceholder(a.target, { exact: false }).first();
  }
  // click_selector, select_option, fill_selector all address by CSS.
  return page.locator(a.target).first();
}

/** The choices a matched <select> actually offers (labels and values). */
async function readSelectOptions(loc) {
  try {
    const options = await loc.locator("option").evaluateAll((nodes) =>
      nodes.map((n) => ({
        label: String(n.textContent ?? "").trim(),
        value: String(n.getAttribute("value") ?? "")
      }))
    );
    return Array.isArray(options) ? options : [];
  } catch {
    // A custom dropdown that is not a real <select>, or a detached node. We
    // cannot enumerate it, so we do not claim the option is missing.
    return [];
  }
}

/** Case-insensitive match against an option's label OR its value, like selectOption. */
function optionMatches(option, wanted) {
  const want = String(wanted ?? "").trim().toLowerCase();
  return (
    option.label.toLowerCase() === want ||
    option.value.toLowerCase() === want ||
    option.label.toLowerCase().includes(want)
  );
}

export async function checkAction(page, a, opts = {}) {
  const base = { kind: a.kind, target: a.target };
  let loc;
  try {
    loc = await locateActionTarget(page, a, opts);
  } catch (e) {
    // A malformed CSS selector throws at locate time rather than resolving to
    // zero elements. That is a real authoring answer, so report the reason.
    return { ...base, state: "absent", detail: condenseError(String(e?.message ?? e)) };
  }
  if (!loc) return { ...base, state: "absent" };

  const state = await probeLocator(loc);
  if (state !== "ready") return { ...base, state };

  if (a.kind === "select_option") {
    const options = await readSelectOptions(loc);
    // An empty list means "could not enumerate", not "offers nothing": a
    // custom dropdown is a real pattern and must not be reported as broken.
    if (options.length > 0 && !options.some((o) => optionMatches(o, a.value))) {
      return {
        ...base,
        state: "missing_option",
        options: options.map((o) => o.label || o.value).filter(Boolean).slice(0, 20)
      };
    }
  }
  return { ...base, state: "ready" };
}
