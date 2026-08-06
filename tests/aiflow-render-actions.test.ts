import { describe, it, expect } from "vitest";
import {
  runAction,
  condenseError,
  parseActions,
  dismissBlockingOverlays,
  CLOSE_NAME_RE,
  AGREE_NAME_RE,
  CLOSE_ATTR_RE,
  CLOSE_ICON_RE
} from "../vps/aiflow-render/actions.mjs";

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
type StubRun = { clicks: number; probes: number };

function makeStubPage(script: LocatorScript): { page: unknown; run: StubRun } {
  const run: StubRun = { clicks: 0, probes: 0 };
  const enabled = [...(script.enabled ?? [true])];
  const clickErrors = [...(script.clickErrors ?? [])];

  const locator = {
    first: () => locator,
    or: () => locator,
    and: () => locator,
    count: async () => script.count ?? 1,
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
    waitForTimeout: async () => {},
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

    await expect(
      runAction(page, { kind: "click_text", target: "Accept", value: "" })
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
