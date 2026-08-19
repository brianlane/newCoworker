import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  checkActions,
  runAction,
  condenseError,
  parseActions,
  dismissBlockingOverlays,
  CLOSE_NAME_RE,
  AGREE_NAME_RE,
  CLOSE_ATTR_RE,
  CLOSE_ICON_RE,
  MAX_FOREACH_ITEMS,
  capForEachList
} from "../vps/aiflow-render/actions.mjs";
import { SWEEP_CAPACITY } from "../scripts/oneshot/amy-clever-weekly-update-sweep-definition";

const actionsSource = readFileSync(
  new URL("../vps/aiflow-render/actions.mjs", import.meta.url),
  "utf8"
);

/**
 * ACTION-mode engine tests for the per-tenant render sidecar.
 *
 * The engine used to live inside `vps/aiflow-render/server.mjs`, which calls
 * `app.listen` at import time and exports nothing, so none of it could be
 * tested. It now lives in `actions.mjs` and takes a Playwright `page` as a
 * parameter, which is all these tests need: a stub page whose locators return
 * scripted answers for `count` / `waitFor` / `isEnabled` / `click`.
 *
 * What is being pinned here is one production incident. On 2026-08-04 Amy
 * Laidlaw's "Clever Lead - Accept" flow walked the portal's accept wizard to
 * completion, the referral WAS accepted, and then the run was dead-lettered
 * anyway: the finished wizard left its primary button visible but disabled, the
 * loop's presence probe asked only "visible?", and the click it guarded demands
 * full actionability, so `locator.click` burned its 10s timeout and threw. The
 * step was permanent-failed and 19 downstream steps (the QT email, the offer to
 * the teammate, the bad-phone retry ladder) never ran.
 */

type LocatorScript = {
  /** How many elements the locator resolves to. */
  count?: number;
  /**
   * Counts answered one per `.count()` call, last value repeating. Models a
   * control that is not in the DOM yet and mounts a moment later.
   */
  counts?: number[];
  /** Reject `waitFor({state:"visible"})`, i.e. hidden or detached. */
  invisible?: boolean;
  /** `isEnabled()` answers. Consumed one per probe; the last value repeats. */
  enabled?: boolean[];
  /** `click()` rejections. Consumed one per click; undefined means it resolves. */
  clickErrors?: (Error | undefined)[];
};

function timeoutError(): Error {
  // Shaped like the real thing, tail included, so condenseError is exercised on
  // a realistic string rather than a synthetic one.
  return new Error(
    "locator.click: Timeout 10000ms exceeded.\nCall log:\n" +
      "  - waiting for getByRole('button', { name: 'Next', exact: true })\n" +
      '    - locator resolved to <button type="button" data-testid="Button-primary">Next</button>\n' +
      "  - element is not enabled\n  - retrying click action"
  );
}

/** Records what the engine actually did, so assertions can check clicks. */
type StubRun = { clicks: number; probes: number; waits: number };

function makeStubPage(script: LocatorScript): { page: unknown; run: StubRun } {
  const run: StubRun = { clicks: 0, probes: 0, waits: 0 };
  const enabled = [...(script.enabled ?? [true])];
  const clickErrors = [...(script.clickErrors ?? [])];
  const counts = [...(script.counts ?? [])];

  const locator = {
    first: () => locator,
    or: () => locator,
    and: () => locator,
    count: async () => {
      if (counts.length > 0) return counts.length > 1 ? counts.shift()! : counts[0]!;
      return script.count ?? 1;
    },
    waitFor: async () => {
      run.probes++;
      if (script.invisible) throw new Error("waiting for locator to be visible");
    },
    isEnabled: async () => (enabled.length > 1 ? enabled.shift()! : (enabled[0] ?? true)),
    click: async () => {
      const err = clickErrors.length > 0 ? clickErrors.shift() : undefined;
      if (err) throw err;
      run.clicks++;
    }
  };

  const page = {
    getByRole: () => locator,
    getByText: () => locator,
    getByPlaceholder: () => locator,
    locator: () => locator,
    waitForLoadState: async () => {},
    waitForTimeout: async () => {
      run.waits++;
    },
    evaluate: async () => "",
    url: () => "https://portal.example.com/lead/1"
  };
  return { page, run };
}

const NEXT = { kind: "click_text_while_present", target: "Next", value: "" };

describe("click_text_while_present", () => {
  it("succeeds when a finished wizard leaves its button visible but disabled", async () => {
    // The Aug 4 2026 Clever incident: three pages of the wizard advance, then
    // the accept posts and the primary button goes inert while it unmounts.
    const { page, run } = makeStubPage({ enabled: [true, true, true, false] });

    await expect(runAction(page, NEXT)).resolves.toBeUndefined();
    expect(run.clicks).toBe(3);
  });

  it("still fails loudly when the button is disabled and nothing ever advanced", async () => {
    // Nothing moved, so the page is genuinely stuck rather than finished. This
    // must stay an error or the following browse_extract reads a half-done page.
    const { page, run } = makeStubPage({ enabled: [false] });

    await expect(runAction(page, NEXT)).rejects.toThrow(
      '"Next" is on the page but never became clickable'
    );
    expect(run.clicks).toBe(0);
  });

  it("does not spend a click timeout to discover the button is inert", async () => {
    // The old code reached this state by calling click() and waiting out
    // ACTION_TIMEOUT_MS. The probe now answers it without clicking at all.
    const { page, run } = makeStubPage({ enabled: [false] });

    await expect(runAction(page, NEXT)).rejects.toThrow();
    expect(run.clicks).toBe(0);
  });

  it("treats zero matches as success", async () => {
    // Load-bearing: scripts/oneshot/patch-clever-accept-followup.ts uses a
    // target that matches nothing as a deliberate no-op "just open the page".
    const { page, run } = makeStubPage({ count: 0 });

    await expect(runAction(page, NEXT)).resolves.toBeUndefined();
    expect(run.clicks).toBe(0);
  });

  it("treats a control that never becomes visible as gone", async () => {
    const { page, run } = makeStubPage({ invisible: true });

    await expect(runAction(page, NEXT)).resolves.toBeUndefined();
    expect(run.clicks).toBe(0);
  });

  it("fails when the target is still clickable after the click cap", async () => {
    const { page, run } = makeStubPage({ enabled: [true] });

    await expect(runAction(page, NEXT)).rejects.toThrow("still present after 10 clicks");
    expect(run.clicks).toBe(10);
  });

  it("ends the loop when the click itself rejects after progress", async () => {
    // The control can also go inert between the probe and the click. With a
    // click already landed that is the same "wizard finished" signal.
    const { page, run } = makeStubPage({
      enabled: [true],
      clickErrors: [undefined, undefined, timeoutError()]
    });

    await expect(runAction(page, NEXT)).resolves.toBeUndefined();
    expect(run.clicks).toBe(2);
  });

  it("rethrows when the very first click rejects", async () => {
    const { page, run } = makeStubPage({ enabled: [true], clickErrors: [timeoutError()] });

    await expect(runAction(page, NEXT)).rejects.toThrow("Timeout 10000ms exceeded");
    expect(run.clicks).toBe(0);
  });
});

describe("click_text", () => {
  it("fails when nothing on the page matches", async () => {
    const { page } = makeStubPage({ count: 0 });

    // appearTimeoutMs 0 skips the hydration wait a single click_text now does.
    // This assertion is about the outcome when a control genuinely never
    // exists, and paying the real wait to prove it would put five seconds into
    // the unit suite for nothing. The wait itself is covered separately.
    await expect(
      runAction(page, { kind: "click_text", target: "Accept", value: "" }, { appearTimeoutMs: 0 })
    ).rejects.toThrow("no matching control on the page");
  });

  it("clicks a resolved control", async () => {
    const { page, run } = makeStubPage({});

    await runAction(page, { kind: "click_text", target: "Accept", value: "" });
    expect(run.clicks).toBe(1);
  });
});

describe("condenseError", () => {
  it("keeps a short message untouched", () => {
    expect(condenseError("click failed")).toBe("click failed");
  });

  it("keeps the reason at the END of a long Playwright call log", () => {
    // The old flat .slice(0, 300) cut exactly here, so a stored failure read
    // "locator resolved to <button ... data-sentry" and stopped, hiding WHY.
    const long = `${"x".repeat(2000)}\n  - element is not enabled`;
    const out = condenseError(long);

    expect(out).toContain("element is not enabled");
    expect(out.startsWith("xxxx")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(600);
  });

  it("stays inside the worker's last_error budget", () => {
    expect(condenseError("y".repeat(50_000)).length).toBeLessThanOrEqual(600);
  });
});

describe("parseActions", () => {
  it("rejects an unknown kind", () => {
    expect(parseActions([{ kind: "click_everything", target: "Next" }])).toBeNull();
  });

  it("rejects an action with no target", () => {
    expect(parseActions([{ kind: "click_text", target: "" }])).toBeNull();
  });

  it("rejects click_role without an accessible name", () => {
    expect(parseActions([{ kind: "click_role", target: "option" }])).toBeNull();
  });

  it("rejects more than the action cap", () => {
    const many = Array.from({ length: 16 }, () => ({ kind: "click_text", target: "Next" }));
    expect(parseActions(many)).toBeNull();
  });

  it("normalizes a valid sequence", () => {
    expect(
      parseActions([
        { kind: "click_text", target: "Accept" },
        { kind: "click_text_while_present", target: "Next" }
      ])
    ).toEqual([
      { kind: "click_text", target: "Accept", value: "" },
      { kind: "click_text_while_present", target: "Next", value: "" }
    ]);
  });
});

/**
 * Overlay dismissal safelists.
 *
 * These are the whole security surface of `dismissBlockingOverlays`: they decide
 * which control inside a full-viewport modal the render service is allowed to
 * click on a live tenant portal. The strings below are taken verbatim from the
 * page HomeLight served on 2026-08-05, captured by the failed run and stored in
 * the aiflow-screenshots bucket.
 *
 * The bug they pin: HomeLight's "This client prefers texting" modal closes via
 *   <div role="button" data-test="modal__close-button">
 *     <svg aria-hidden="true" data-icon="times">
 * whose accessible name (`aria-label || textContent`) is the EMPTY STRING. The
 * name-based list never matched, nothing was picked, and the dismisser reported
 * "no blocking modal" while a full-screen modal covered the claim button.
 */
describe("overlay dismissal safelists", () => {
  it("does not match an empty accessible name by name alone", () => {
    // The heart of the failure: an unnamed control is invisible to these.
    expect(CLOSE_NAME_RE.test("")).toBe(false);
    expect(AGREE_NAME_RE.test("")).toBe(false);
  });

  it("still matches the named close controls it always did", () => {
    for (const n of ["Close", "close", "Dismiss", "Got it", "Not now", "Skip", "x", "×"]) {
      expect(CLOSE_NAME_RE.test(n)).toBe(true);
    }
  });

  it("still matches the agreement controls", () => {
    for (const n of ["Agree and close", "Agree & continue", "I understand", "Scroll to continue"]) {
      expect(AGREE_NAME_RE.test(n)).toBe(true);
    }
  });

  it("recognises HomeLight's close control by its data-test token", () => {
    expect(CLOSE_ATTR_RE.test("modal__close-button")).toBe(true);
  });

  it("recognises an X glyph by its data-icon", () => {
    // HomeLight's svg carries data-icon="times".
    for (const i of ["times", "xmark", "close", "x", "times-circle"]) {
      expect(CLOSE_ICON_RE.test(i)).toBe(true);
    }
  });

  it("does not fire on HomeLight's hashed styled-components classes", () => {
    // The same element's class attribute, verbatim. Nothing close-like in it,
    // so the data-test token is what has to carry the match.
    expect(CLOSE_ATTR_RE.test("sc-76434326-0 lnNLtN")).toBe(false);
  });

  it("does not treat words that merely CONTAIN close as a close button", () => {
    // "closest" and "disclosure" would make the dismisser click arbitrary
    // controls inside a modal, which is exactly what the safelist exists to
    // prevent.
    expect(CLOSE_ATTR_RE.test("closest-match")).toBe(false);
    expect(CLOSE_ATTR_RE.test("disclosure-panel")).toBe(false);
    expect(CLOSE_ATTR_RE.test("enclosure")).toBe(false);
  });

  it("does not treat a consequential icon as a close icon", () => {
    for (const i of ["check", "arrow-right", "paper-plane", "trash"]) {
      expect(CLOSE_ICON_RE.test(i)).toBe(false);
    }
  });

  it("leaves Continue OFF the safelists", () => {
    // Deliberate: HomeLight's modal also has a "Continue" button, but a bare
    // Continue elsewhere can advance a consequential wizard rather than dismiss
    // a layer. The X is the safe affordance.
    expect(CLOSE_NAME_RE.test("Continue")).toBe(false);
    expect(AGREE_NAME_RE.test("Continue")).toBe(false);
  });
});

describe("dismissBlockingOverlays", () => {
  it("hands the page the SAME patterns this file asserts on", async () => {
    // page.evaluate cannot call an outer function, so the browser gets the
    // pattern sources. If someone edits the in-page copy instead of the module
    // constants, this goes red rather than the two silently diverging.
    let received: { protect: string; cfg: Record<string, string> } | null = null;
    const page = {
      evaluate: async (_fn: unknown, arg: { protect: string; cfg: Record<string, string> }) => {
        received = arg;
        return "";
      },
      waitForTimeout: async () => {},
      waitForLoadState: async () => {}
    };

    await dismissBlockingOverlays(page, "Send message");

    expect(received).not.toBeNull();
    expect(received!.protect).toBe("Send message");
    expect(received!.cfg.closeName).toBe(CLOSE_NAME_RE.source);
    expect(received!.cfg.agreeName).toBe(AGREE_NAME_RE.source);
    expect(received!.cfg.closeAttr).toBe(CLOSE_ATTR_RE.source);
    expect(received!.cfg.closeIcon).toBe(CLOSE_ICON_RE.source);
  });

  it("reports nothing dismissed when the page finds no safelisted control", async () => {
    const page = {
      evaluate: async () => "",
      waitForTimeout: async () => {},
      waitForLoadState: async () => {}
    };
    expect(await dismissBlockingOverlays(page, "x")).toBe(0);
  });

  it("stops immediately when the overlay hosts the control we are after", async () => {
    let calls = 0;
    const page = {
      evaluate: async () => {
        calls++;
        return "__protected__";
      },
      waitForTimeout: async () => {},
      waitForLoadState: async () => {}
    };
    expect(await dismissBlockingOverlays(page, "Submit Update")).toBe(0);
    expect(calls).toBe(1);
  });
});


/**
 * The 2026-08-06 Clever incident. Amy Laidlaw's accept step dead-lettered at
 * step 1 with `click_text "Accept": no matching control on the page`, and the
 * page artifact the engine saved alongside that error shows the Accept button
 * plainly present, next to Reject, on a normal invitation page.
 *
 * Every match strategy asks `.count()`, which reads the DOM as it stands right
 * now. On a client-rendered portal the shell can paint and the network go quiet
 * before hydration mounts the control, so the action concluded "no such
 * control" against a page that was about to have one.
 */
describe("click_text waits for a control that has not hydrated yet", () => {
  const ACCEPT = { kind: "click_text", target: "Accept", value: "" };

  it("clicks a control that mounts after the first look", async () => {
    // Five strategies each ask once per pass, so a whole pass sees 0 before the
    // control appears on the next.
    const { page, run } = makeStubPage({ counts: [0, 0, 0, 0, 0, 1] });

    await expect(runAction(page, ACCEPT, { appearTimeoutMs: 2_000 })).resolves.toBeUndefined();
    expect(run.clicks).toBe(1);
    // It genuinely waited rather than getting lucky on a retry-free path.
    expect(run.waits).toBeGreaterThan(0);
  });

  it("still fails when the control never appears", async () => {
    const { page } = makeStubPage({ count: 0 });
    // appearTimeoutMs 0 keeps this assertion about the OUTCOME rather than
    // spending the real wait proving it.
    await expect(
      runAction(page, ACCEPT, { appearTimeoutMs: 0 })
    ).rejects.toThrow(/no matching control/);
  });

  // The whole point of scoping the wait to a single click: for the loop, zero
  // matches is how it knows the wizard is finished. Waiting there would add the
  // timeout to the end of every successful run.
  it("does not make the while-present loop wait for absence", async () => {
    const { page, run } = makeStubPage({ count: 0 });
    await expect(
      runAction(page, { kind: "click_text_while_present", target: "Next", value: "" })
    ).resolves.toBeUndefined();
    expect(run.waits).toBe(0);
  });
});

/**
 * The forEachLink cap is sized against an edge timeout, not against taste.
 *
 * The whole loop runs inside ONE HTTP response that crosses a Cloudflare Tunnel
 * with no `originRequest` overrides, so it gets Cloudflare's default ~100s 524.
 * The cap sat at 25 for months, which is ~330s of work at the fleet's measured
 * pace: undeliverable, and dangerous rather than merely wasteful, because the
 * worker retries a 524 and re-submits every row the timed-out pass already did.
 *
 * These numbers come from Amy Laidlaw's own completed Clever sweeps, timed from
 * the browse step's stored timestamps (items -> seconds):
 *   1 -> 20.0 | 2 -> 32.0 | 3 -> 45.4 | 4 -> 59.0 | 5 -> 60.0 | 0 -> 4.8
 * which fits ~5s fixed plus ~13s per item.
 *
 * If you are here because you want a bigger backlog covered: that already
 * works. The worker CHAINS capped passes (it reads `remaining` off each
 * response, defers, and re-enters the same step until the list drains), so
 * this cap is a per-pass chunk size. Raising it just moves the failure from
 * "honestly chunked" to "timed out halfway and then did it twice".
 */
describe("MAX_FOREACH_ITEMS fits inside the Cloudflare edge budget", () => {
  const EDGE_TIMEOUT_S = 100;
  const FIXED_COST_S = 5;
  const PER_ITEM_COST_S = 13;
  const worstCase = (items: number) => FIXED_COST_S + items * PER_ITEM_COST_S;

  it("completes a full pass well inside the ~100s edge timeout", () => {
    expect(worstCase(MAX_FOREACH_ITEMS)).toBeLessThan(EDGE_TIMEOUT_S);
  });

  it("keeps real headroom, not a one-second squeak past the line", () => {
    expect(EDGE_TIMEOUT_S - worstCase(MAX_FOREACH_ITEMS)).toBeGreaterThanOrEqual(10);
  });

  it("would have failed at the old cap of 25, which is why it moved", () => {
    expect(worstCase(25)).toBeGreaterThan(EDGE_TIMEOUT_S);
  });

  it("still processes enough items to be worth looping at all", () => {
    expect(MAX_FOREACH_ITEMS).toBeGreaterThanOrEqual(5);
  });

  it("matches the per-pass capacity the Clever sweep one-shots were sized against", () => {
    // Since chaining landed, the cap is a chunk size rather than the sweep's
    // coverage, and the live alert reads measured `<id>_updated`/`<id>_left`
    // vars instead of baking this number in. The pin stays so the applied
    // one-shot's recorded arithmetic remains true of the fleet default.
    expect(MAX_FOREACH_ITEMS).toBe(SWEEP_CAPACITY);
  });

  it("stays overridable per box for an emergency, without a code change", () => {
    expect(actionsSource).toContain("process.env.AIFLOW_MAX_FOREACH_ITEMS");
  });
});

/**
 * The truncation arithmetic the worker's pass chaining depends on. `remaining`
 * is the field that tells the worker another pass is owed; the note is the
 * error string the skipped tail shows up as for workers that predate chaining
 * (they count it inside `failed`).
 */
describe("capForEachList", () => {
  const href = (n: number) => `https://portal/card/${n}`;
  const list = (n: number) => Array.from({ length: n }, (_, i) => href(i));

  it("keeps everything and reports nothing remaining under the cap", () => {
    expect(capForEachList(list(MAX_FOREACH_ITEMS - 1))).toEqual({
      kept: list(MAX_FOREACH_ITEMS - 1),
      remaining: 0,
      capNote: null
    });
  });

  it("keeps exactly the cap with nothing remaining at the boundary", () => {
    expect(capForEachList(list(MAX_FOREACH_ITEMS))).toEqual({
      kept: list(MAX_FOREACH_ITEMS),
      remaining: 0,
      capNote: null
    });
  });

  it("slices to the cap and reports the tail, in both the count and the note", () => {
    const out = capForEachList(list(30));
    expect(out.kept).toEqual(list(MAX_FOREACH_ITEMS));
    expect(out.remaining).toBe(30 - MAX_FOREACH_ITEMS);
    expect(out.capNote).toBe(
      `forEachLink matched 30 items; capped at ${MAX_FOREACH_ITEMS}, ${30 - MAX_FOREACH_ITEMS} not processed`
    );
  });

  it("handles an empty list without inventing a note", () => {
    expect(capForEachList([])).toEqual({ kept: [], remaining: 0, capNote: null });
  });
});


/**
 * DRY RUN (checkActions). The dashboard's "Test with a contact" simulates
 * browse steps entirely, so before this a selector's first real test was a
 * live lead. What has to hold: the verdicts match what the real action would
 * meet, and NOTHING is performed.
 */
describe("checkActions (dry run)", () => {
  it("reports a resolvable, enabled control as ready and clicks nothing", async () => {
    const { page, run } = makeStubPage({ enabled: [true] });

    const checks = await checkActions(page, [
      { kind: "click_text", target: "Claim this lead", value: "" }
    ]);

    expect(checks).toEqual([
      { kind: "click_text", target: "Claim this lead", state: "ready" }
    ]);
    // The whole point: a dry run that clicked would accept a real referral.
    expect(run.clicks).toBe(0);
  });

  it("performs nothing across a whole sequence", async () => {
    const { page, run } = makeStubPage({ enabled: [true] });

    await checkActions(page, [
      { kind: "click_text", target: "Accept", value: "" },
      { kind: "fill_selector", target: 'textarea[name="message"]', value: "hello" },
      { kind: "click_selector", target: "[data-test=submit]", value: "" }
    ]);

    expect(run.clicks).toBe(0);
  });

  it("reports a control that is not on the page as absent", async () => {
    const { page } = makeStubPage({ count: 0 });

    const checks = await checkActions(page, [
      { kind: "click_text", target: "Claim this lead", value: "" }
    ]);

    expect(checks[0].state).toBe("absent");
  });

  it("reports a present-but-inert control as blocked, not absent", async () => {
    // The distinction matters to the owner: "blocked" is normal for a button
    // that wakes up once something above it is filled in, while "absent" means
    // the selector is wrong.
    const { page } = makeStubPage({ enabled: [false] });

    const checks = await checkActions(page, [
      { kind: "click_selector", target: "button.submit", value: "" }
    ]);

    expect(checks[0].state).toBe("blocked");
  });

  it("treats a control that never becomes visible as absent", async () => {
    const { page } = makeStubPage({ invisible: true });

    const checks = await checkActions(page, [
      { kind: "click_selector", target: "button.submit", value: "" }
    ]);

    expect(checks[0].state).toBe("absent");
  });

  it("reaches the same verdict the while-present loop acts on", async () => {
    // probeLocator is shared with probeClickable on purpose: a check that
    // judged actionability differently from the thing it predicts would be
    // worse than no check.
    const { page } = makeStubPage({ enabled: [false] });

    const [check] = await checkActions(page, [
      { kind: "click_text_while_present", target: "Next", value: "" }
    ]);
    // Same state the loop reads before refusing to call this a finished wizard.
    expect(check.state).toBe("blocked");
    await expect(runAction(page, { kind: "click_text_while_present", target: "Next", value: "" }))
      .rejects.toThrow("never became clickable");
  });

  it("checks every action rather than stopping at the first miss", async () => {
    // A run stops at the first failure; a check must not, or fixing one
    // selector only reveals the next one.
    const { page } = makeStubPage({ count: 0 });

    const checks = await checkActions(
      page,
      [
        { kind: "click_text", target: "A", value: "" },
        { kind: "click_text", target: "B", value: "" },
        { kind: "click_text", target: "C", value: "" }
      ],
      { totalAppearMs: 100 }
    );

    expect(checks.map((c) => c.target)).toEqual(["A", "B", "C"]);
  });

  it("shares ONE appear budget across the sequence instead of paying it per action", async () => {
    // Without this the worst case is 15 x CLICK_TEXT_APPEAR_MS, and the whole
    // dry run is a single response behind a Cloudflare Tunnel with a ~100s
    // ceiling. The owner would get an unexplained 524 from the button whose
    // job is to explain failures.
    const { page } = makeStubPage({ count: 0 });
    const started = Date.now();

    const checks = await checkActions(
      page,
      Array.from({ length: 8 }, (_, i) => ({
        kind: "click_text",
        target: `T${i}`,
        value: ""
      })),
      { totalAppearMs: 200 }
    );

    expect(checks).toHaveLength(8);
    expect(checks.every((c) => c.state === "absent")).toBe(true);
    // Eight actions, one budget: nowhere near 8 x the per-action timeout.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("still resolves a control that IS present after the budget is spent", async () => {
    // Losing the grace period must not turn a working action into a miss: the
    // immediate resolution pass still runs for every action.
    const { page } = makeStubPage({ enabled: [true] });

    const checks = await checkActions(
      page,
      [
        { kind: "click_text", target: "A", value: "" },
        { kind: "click_text", target: "B", value: "" }
      ],
      { totalAppearMs: 0 }
    );

    expect(checks.map((c) => c.state)).toEqual(["ready", "ready"]);
  });

  it("reports a malformed selector with the reason instead of throwing", async () => {
    const page = {
      locator: () => {
        throw new Error("Unexpected token while parsing selector");
      }
    };

    const checks = await checkActions(page, [
      { kind: "click_selector", target: "button[", value: "" }
    ]);

    expect(checks[0].state).toBe("absent");
    expect(checks[0].detail).toContain("selector");
  });

  it("says when a dropdown exists but does not offer the chosen option", async () => {
    const optionLocator = {
      evaluateAll: async () => [
        { label: "New", value: "new" },
        { label: "Spoke with them", value: "spoke" }
      ]
    };
    const page = {
      locator: () => ({
        first: () => ({
          waitFor: async () => {},
          isEnabled: async () => true,
          locator: () => optionLocator
        })
      })
    };

    const checks = await checkActions(page, [
      { kind: "select_option", target: "select[name=stage]", value: "Under contract" }
    ]);

    expect(checks[0]).toMatchObject({
      state: "missing_option",
      options: ["New", "Spoke with them"]
    });
  });

  it("accepts an option matched by its value or by a partial label", async () => {
    const make = (wanted: string) => {
      const optionLocator = {
        evaluateAll: async () => [{ label: "Spoke with them", value: "spoke" }]
      };
      const page = {
        locator: () => ({
          first: () => ({
            waitFor: async () => {},
            isEnabled: async () => true,
            locator: () => optionLocator
          })
        })
      };
      return checkActions(page, [
        { kind: "select_option", target: "select[name=stage]", value: wanted }
      ]);
    };

    expect((await make("spoke"))[0].state).toBe("ready");
    expect((await make("Spoke"))[0].state).toBe("ready");
    expect((await make("SPOKE WITH THEM"))[0].state).toBe("ready");
  });

  it("does not claim a custom dropdown is missing an option it cannot enumerate", async () => {
    // A div-based combobox is a real pattern; reporting it as broken would
    // send an owner rewriting a step that works.
    const page = {
      locator: () => ({
        first: () => ({
          waitFor: async () => {},
          isEnabled: async () => true,
          locator: () => ({
            evaluateAll: async () => {
              throw new Error("not a select");
            }
          })
        })
      })
    };

    const checks = await checkActions(page, [
      { kind: "select_option", target: "div[role=combobox]", value: "Anything" }
    ]);

    expect(checks[0].state).toBe("ready");
  });
});

describe("the dry run cannot perform actions", () => {
  it("the check responder never reaches the action engine", () => {
    // Structural, not a flag: server.mjs routes checkOnly to its own responder.
    // If that body ever grows a performActions call, a dry run silently starts
    // clicking on a live portal, and no unit test with a stub page would see it.
    const serverSrc = readFileSync(
      new URL("../vps/aiflow-render/server.mjs", import.meta.url),
      "utf8"
    );
    const start = serverSrc.indexOf("async function respondWithActionChecks(");
    expect(start).toBeGreaterThan(-1);
    const body = serverSrc.slice(start, serverSrc.indexOf("\nasync function", start + 10));
    for (const forbidden of ["performActions", "performForEach", "waitForExpectedText"]) {
      expect(body, `respondWithActionChecks must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("gives the dry run its own path, so an un-redeployed box 404s instead of clicking", () => {
    // The deployment gap is real: the app ships on merge, this sidecar only on
    // a manual per-tenant redeploy. An old box ignores an unknown checkOnly
    // flag and falls through to performActions, so the path is what makes the
    // window safe.
    const serverSrc = readFileSync(
      new URL("../vps/aiflow-render/server.mjs", import.meta.url),
      "utf8"
    );
    expect(serverSrc).toContain('app.post("/check-actions"');
    // And it FORCES the mode rather than defaulting it, so a request that
    // arrives on that path cannot perform actions however it was shaped.
    const start = serverSrc.indexOf('app.post("/check-actions"');
    expect(serverSrc.slice(start, start + 300)).toContain("checkOnly: true");
  });

  it("refuses checkOnly without actions, and alongside forEachLink", () => {
    const serverSrc = readFileSync(
      new URL("../vps/aiflow-render/server.mjs", import.meta.url),
      "utf8"
    );
    expect(serverSrc).toContain("if (checkOnly && (!actions || forEachLink))");
  });
});
