import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  CONFIRM_LABEL_RE,
  createDemoStore,
  collectHitAtPoint,
  DEMO_ACT_KINDS,
  DEMO_TYPEABLE_INPUT_TYPES,
  deriveDemoCandidates,
  diagnosticsMarks,
  isConfirmRequired,
  parseDemoAction,
  pickVerifiedCandidate,
  resolveDemoPointAction,
  sliceDiagnostics,
  STABLE_ID_RE,
  type DemoHit
} from "../vps/aiflow-render/demo.mjs";

/**
 * DEMONSTRATION-mode engine tests (vps/aiflow-render/demo.mjs).
 *
 * Same stub-page discipline as tests/aiflow-render-actions.test.ts: everything
 * here drives the engine with scripted objects, no Express and no Chromium.
 * What is being pinned:
 *
 *  - A recorded action must be one of the ENGINE's kinds, shaped by the
 *    engine's own parser, or a demonstration could record something a flow
 *    cannot replay.
 *  - A point click is recorded only when the derived selector resolves BACK
 *    to the element the owner clicked. The second-Edit-button-in-a-table case
 *    must reject the text candidate, not record a click on the wrong row.
 *  - The session store releases EXACTLY once however many paths race, because
 *    a leaked release pins a refcounted auth context forever (evictStale
 *    never evicts inUse > 0).
 *  - The confirm gate reads the same destructive-label vocabulary as the
 *    engineer probe, and the typeable-input allowlist matches the app digest,
 *    both pinned against the other file's SOURCE so the copies cannot drift.
 */

function hit(partial: Partial<DemoHit>): DemoHit {
  return {
    tag: "button",
    inputType: "",
    name: "",
    id: "",
    dataTest: "",
    dataTestId: "",
    ariaLabel: "",
    role: "",
    text: "",
    placeholder: "",
    valueAttr: "",
    disabled: false,
    href: "",
    ...partial
  };
}

describe("parseDemoAction", () => {
  it("accepts every engine kind except click_text_while_present", () => {
    expect([...DEMO_ACT_KINDS].sort()).toEqual(
      ["click_role", "click_selector", "click_text", "fill_placeholder", "fill_selector", "select_option"].sort()
    );
    expect(parseDemoAction({ kind: "click_text", target: "Next" })).toEqual({
      kind: "click_text",
      target: "Next",
      value: "",
      optional: false
    });
    expect(parseDemoAction({ kind: "click_text_while_present", target: "Next" })).toBeNull();
    expect(parseDemoAction({ kind: "navigate", target: "x" })).toBeNull();
  });

  it("normalizes through the engine's own parser (value rules included)", () => {
    // select_option requires a value, exactly like /render.
    expect(parseDemoAction({ kind: "select_option", target: "select[name=\"a\"]" })).toBeNull();
    expect(
      parseDemoAction({ kind: "select_option", target: "select[name=\"a\"]", value: "9" })
    ).toEqual({ kind: "select_option", target: "select[name=\"a\"]", value: "9", optional: false });
  });

  it("strips optional: a demonstration fails loudly, never skips", () => {
    const parsed = parseDemoAction({
      kind: "select_option",
      target: "select[name=\"a\"]",
      value: "9",
      optional: true
    });
    expect(parsed).not.toBeNull();
    expect((parsed as { optional: boolean }).optional).toBe(false);
  });

  it("validates point coordinates and bounds", () => {
    expect(parseDemoAction({ kind: "click_point", x: 10.6, y: 20 })).toEqual({
      kind: "click_point",
      x: 11,
      y: 20,
      value: ""
    });
    expect(parseDemoAction({ kind: "click_point", x: -1, y: 20 })).toBeNull();
    expect(parseDemoAction({ kind: "click_point", x: 10, y: 20_001 })).toBeNull();
    expect(parseDemoAction({ kind: "click_point", x: Number.NaN, y: 20 })).toBeNull();
    expect(parseDemoAction({ kind: "click_point", x: "12", y: "34" })).toEqual({
      kind: "click_point",
      x: 12,
      y: 34,
      value: ""
    });
  });

  it("caps a fill_point value and allows an empty one (clearing a field)", () => {
    expect(parseDemoAction({ kind: "fill_point", x: 1, y: 1, value: "a".repeat(2001) })).toBeNull();
    expect(parseDemoAction({ kind: "fill_point", x: 1, y: 1, value: "" })).toEqual({
      kind: "fill_point",
      x: 1,
      y: 1,
      value: ""
    });
  });
});

describe("the confirm gate", () => {
  it("requires confirm on destructive-labeled targets", () => {
    expect(isConfirmRequired({ kind: "click_text", target: "Submit Update" })).toBe(true);
    expect(isConfirmRequired({ kind: "click_selector", target: '[data-test="claim-button"]' })).toBe(true);
    expect(isConfirmRequired({ kind: "click_text", target: "Provide Update" })).toBe(false);
  });

  it("reads the chosen value on select/role kinds, but never on fills", () => {
    expect(
      isConfirmRequired({ kind: "select_option", target: 'select[name="status"]', value: "Remove" })
    ).toBe(true);
    expect(
      isConfirmRequired({ kind: "click_role", target: "button", value: "Accept referral" })
    ).toBe(true);
    // A fill's value is the owner's own prose; only the TARGET can commit.
    expect(
      isConfirmRequired({
        kind: "fill_selector",
        target: 'textarea[name="message"]',
        value: "please cancel my Tuesday viewing"
      })
    ).toBe(false);
  });

  it("matches the engineer probe's destructive-target vocabulary verbatim", () => {
    const probeSource = readFileSync(
      new URL("../debug/portal-dom-probe.ts", import.meta.url),
      "utf8"
    );
    const m = /DESTRUCTIVE_TARGETS\s*=\s*\n?\s*(\/[^/]+\/i)/.exec(probeSource);
    expect(m, "portal-dom-probe.ts no longer defines DESTRUCTIVE_TARGETS?").toBeTruthy();
    expect(CONFIRM_LABEL_RE.toString()).toBe(m![1]);
    // The smoke CLI carries its own copy (it refuses instead of confirming).
    const smokeSource = readFileSync(
      new URL("../debug/demo-session-smoke.ts", import.meta.url),
      "utf8"
    );
    const s = /DESTRUCTIVE_TARGETS\s*=\s*\n?\s*(\/[^/]+\/i)/.exec(smokeSource);
    expect(s, "demo-session-smoke.ts no longer defines DESTRUCTIVE_TARGETS?").toBeTruthy();
    expect(s![1]).toBe(m![1]);
  });
});

describe("the typeable-input allowlist", () => {
  it("matches the app digest's TYPEABLE_INPUT_TYPES (password structurally absent)", () => {
    const controlsSource = readFileSync(
      new URL("../src/lib/ai-flows/page-controls.ts", import.meta.url),
      "utf8"
    );
    const m = /TYPEABLE_INPUT_TYPES = new Set\(\[([\s\S]*?)\]\)/.exec(controlsSource);
    expect(m, "page-controls.ts no longer defines TYPEABLE_INPUT_TYPES?").toBeTruthy();
    const appTypes = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    expect([...DEMO_TYPEABLE_INPUT_TYPES].sort()).toEqual(appTypes);
    expect(DEMO_TYPEABLE_INPUT_TYPES.has("password")).toBe(false);
  });
});

describe("createDemoStore", () => {
  function harness(opts?: { maxSessions?: number }) {
    let t = 0;
    const closes: string[] = [];
    const store = createDemoStore({
      now: () => t,
      idleTtlMs: 100,
      maxLifetimeMs: 1000,
      maxSessions: opts?.maxSessions ?? 2
    });
    const seed = (demoId: string, businessId: string) => ({
      demoId,
      businessId,
      page: {},
      close: () => {
        closes.push(demoId);
      }
    });
    return { store, seed, closes, tick: (ms: number) => (t += ms), at: () => t };
  }

  it("binds a session to its business: a mismatch answers like unknown", async () => {
    const { store, seed } = harness();
    const s = await store.create(seed("d1", "biz-a"));
    expect(s).not.toBeNull();
    expect(store.get("d1", "biz-a")).toBe(s);
    expect(store.get("d1", "biz-b")).toBeNull();
    expect(store.get("nope", "biz-a")).toBeNull();
  });

  it("releases exactly once however many paths race", async () => {
    const { store, seed, closes } = harness();
    const s = (await store.create(seed("d1", "biz-a")))!;
    await store.release(s);
    await store.release(s);
    await store.sweep();
    expect(closes).toEqual(["d1"]);
    expect(store.get("d1", "biz-a")).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("swallows a close that throws (the sweep must survive one bad page)", async () => {
    const { store } = harness();
    const s = (await store.create({
      demoId: "d1",
      businessId: "biz-a",
      page: {},
      close: () => {
        throw new Error("target closed");
      }
    }))!;
    await expect(store.release(s)).resolves.toBeUndefined();
  });

  it("sweeps idle sessions, and a touch resets the idle clock", async () => {
    const { store, seed, closes, tick } = harness();
    const s = (await store.create(seed("d1", "biz-a")))!;
    tick(90);
    store.touch(s);
    tick(90);
    await store.sweep();
    expect(closes).toEqual([]); // 90 < 100 idle after the touch
    tick(101);
    await store.sweep();
    expect(closes).toEqual(["d1"]);
  });

  it("sweeps at the hard lifetime even when constantly touched", async () => {
    const { store, seed, closes, tick } = harness();
    const s = (await store.create(seed("d1", "biz-a")))!;
    for (let i = 0; i < 11; i++) {
      tick(99);
      store.touch(s);
    }
    await store.sweep(); // ~1089ms old, always touched inside the idle TTL
    expect(closes).toEqual(["d1"]);
  });

  it("evicts the oldest SAME-business session at the cap (a retry after a timed-out start)", async () => {
    const { store, seed, closes, tick } = harness();
    await store.create(seed("d1", "biz-a"));
    tick(1);
    await store.create(seed("d2", "biz-b"));
    tick(1);
    const s3 = await store.create(seed("d3", "biz-a"));
    expect(s3).not.toBeNull();
    expect(closes).toEqual(["d1"]);
    expect(store.get("d2", "biz-b")).not.toBeNull();
  });

  it("refuses a THIRD business at the cap instead of evicting someone else's live demo", async () => {
    const { store, seed, closes } = harness();
    await store.create(seed("d1", "biz-a"));
    await store.create(seed("d2", "biz-b"));
    const s3 = await store.create(seed("d3", "biz-c"));
    expect(s3).toBeNull();
    expect(closes).toEqual([]);
  });
});

describe("deriveDemoCandidates", () => {
  it("prefers the vendor's data-test handle, then visible text, in that order", () => {
    const d = deriveDemoCandidates(
      hit({ tag: "button", dataTest: "offer-accept", text: "Accept referral" }),
      "click"
    );
    expect(d.verdict).toBe("candidates");
    if (d.verdict !== "candidates") return;
    expect(d.candidates).toEqual([
      { kind: "click_selector", target: '[data-test="offer-accept"]' },
      { kind: "click_text", target: "Accept referral" }
    ]);
    expect(d.label).toBe("Accept referral");
  });

  it("reads an icon-only button through its aria-label", () => {
    const d = deriveDemoCandidates(hit({ tag: "button", ariaLabel: "Open notes" }), "click");
    expect(d.verdict).toBe("candidates");
    if (d.verdict !== "candidates") return;
    expect(d.candidates).toEqual([{ kind: "click_text", target: "Open notes" }]);
  });

  it("labels an input[type=submit] by its value attribute", () => {
    const d = deriveDemoCandidates(
      hit({ tag: "input", inputType: "submit", valueAttr: "Search now" }),
      "click"
    );
    expect(d.verdict).toBe("candidates");
    if (d.verdict !== "candidates") return;
    expect(d.candidates).toEqual([{ kind: "click_text", target: "Search now" }]);
  });

  it("uses a letters-only id as the last resort and refuses hash-looking ones", () => {
    expect(STABLE_ID_RE.test("save-note")).toBe(true);
    expect(STABLE_ID_RE.test("radix-:r1:")).toBe(false);
    expect(STABLE_ID_RE.test("button-3f9a")).toBe(false);
    const stable = deriveDemoCandidates(hit({ tag: "a", id: "next-page", text: "More" }), "click");
    expect(stable.verdict).toBe("candidates");
    if (stable.verdict !== "candidates") return;
    expect(stable.candidates).toEqual([
      { kind: "click_text", target: "More" },
      { kind: "click_selector", target: "#next-page" }
    ]);
    const hashy = deriveDemoCandidates(hit({ tag: "a", id: "btn-3f9a" }), "click");
    expect(hashy.verdict).toBe("no_stable_selector");
  });

  it("addresses a radio by name AND value, never name alone (radios share names)", () => {
    const d = deriveDemoCandidates(
      hit({ tag: "input", inputType: "radio", name: "reason", valueAttr: "sold" }),
      "click"
    );
    expect(d.verdict).toBe("candidates");
    if (d.verdict !== "candidates") return;
    expect(d.candidates[0]).toEqual({
      kind: "click_selector",
      target: 'input[type="radio"][name="reason"][value="sold"]'
    });
    const bare = deriveDemoCandidates(hit({ tag: "input", inputType: "radio", name: "reason" }), "click");
    expect(bare.verdict).toBe("no_stable_selector");
  });

  it("routes a select to its option chips instead of recording a click", () => {
    const d = deriveDemoCandidates(
      hit({ tag: "select", name: "reminderHour", options: ["9", "10"] }),
      "click"
    );
    expect(d).toEqual({ verdict: "select_needs_option", options: ["9", "10"] });
  });

  it("tells a click on a typeable field to use fill instead", () => {
    const d = deriveDemoCandidates(hit({ tag: "input", inputType: "text", name: "q" }), "click");
    expect(d.verdict).toBe("field_use_fill");
  });

  it("fills by name selector first, then placeholder, exactly like the digest", () => {
    const named = deriveDemoCandidates(
      hit({ tag: "textarea", name: "message", placeholder: "Add a note" }),
      "fill"
    );
    expect(named.verdict).toBe("candidates");
    if (named.verdict !== "candidates") return;
    expect(named.candidates).toEqual([
      { kind: "fill_selector", target: 'textarea[name="message"]' },
      { kind: "fill_placeholder", target: "Add a note" }
    ]);
    const placeholderOnly = deriveDemoCandidates(
      hit({ tag: "input", inputType: "search", placeholder: "Search leads" }),
      "fill"
    );
    expect(placeholderOnly.verdict).toBe("candidates");
    if (placeholderOnly.verdict !== "candidates") return;
    expect(placeholderOnly.candidates).toEqual([
      { kind: "fill_placeholder", target: "Search leads" }
    ]);
  });

  it("refuses to fill a password field structurally, on the point path too", () => {
    const d = deriveDemoCandidates(
      hit({ tag: "input", inputType: "password", name: "password" }),
      "fill"
    );
    expect(d.verdict).toBe("not_typeable");
    const click = deriveDemoCandidates(
      hit({ tag: "input", inputType: "password", name: "password" }),
      "click"
    );
    expect(click.verdict).toBe("not_typeable");
  });

  it("reports a nameless, placeholderless field as unaddressable", () => {
    const d = deriveDemoCandidates(hit({ tag: "input", inputType: "text" }), "fill");
    expect(d.verdict).toBe("field_unaddressable");
  });

  it("drops a data-test value containing a quote instead of building a broken selector", () => {
    const d = deriveDemoCandidates(
      hit({ tag: "button", dataTest: 'say-"hi"', text: "Say hi" }),
      "click"
    );
    expect(d.verdict).toBe("candidates");
    if (d.verdict !== "candidates") return;
    expect(d.candidates).toEqual([{ kind: "click_text", target: "Say hi" }]);
  });
});

/**
 * Stub page for candidate verification: locators are keyed by the string the
 * strategy receives (a CSS selector, a text target, a placeholder), and each
 * scripts how many elements it resolves to and whether the resolved element
 * is the one the owner clicked.
 */
function makeVerifyStubPage(
  map: Record<string, { count?: number; same?: boolean; throws?: boolean }>
) {
  const mk = (key: string) => {
    const spec = map[key] ?? { count: 0 };
    if (spec.throws) throw new Error(`'${key}' is not a valid selector`);
    const locator: {
      first: () => unknown;
      or: () => unknown;
      and: () => unknown;
      count: () => Promise<number>;
      evaluate: (fn: unknown, el: unknown, opts?: unknown) => Promise<boolean>;
    } = {
      first: () => locator,
      or: () => locator,
      and: () => locator,
      count: async () => spec.count ?? 1,
      evaluate: async () => {
        if (spec.count === 0) throw new Error("waiting for element");
        return spec.same === true;
      }
    };
    return locator;
  };
  return {
    locator: (t: string) => mk(t),
    getByRole: (_role: string, opts: { name: string }) => mk(opts.name),
    getByText: (t: string) => mk(t),
    getByPlaceholder: (t: string) => mk(t),
    waitForTimeout: async () => {}
  };
}

describe("pickVerifiedCandidate", () => {
  const element = {}; // identity is checked inside the stubbed evaluate

  it("skips a candidate that resolves to a DIFFERENT element and takes the next", async () => {
    // The second-Edit-button trap: the text strategy resolves to the first
    // "Edit" on the page, which is not the row the owner clicked.
    const page = makeVerifyStubPage({
      Edit: { count: 1, same: false },
      "#edit-row-two": { count: 1, same: true }
    });
    const picked = await pickVerifiedCandidate(
      page,
      [
        { kind: "click_text", target: "Edit" },
        { kind: "click_selector", target: "#edit-row-two" }
      ],
      element
    );
    expect(picked).toEqual({ kind: "click_selector", target: "#edit-row-two" });
  });

  it("returns null when nothing verifies (reported as ambiguous)", async () => {
    const page = makeVerifyStubPage({ Edit: { count: 1, same: false } });
    const picked = await pickVerifiedCandidate(page, [{ kind: "click_text", target: "Edit" }], element);
    expect(picked).toBeNull();
  });

  it("survives a candidate whose selector throws at locate time", async () => {
    const page = makeVerifyStubPage({
      "[data-test=\"a\"": { throws: true },
      Save: { count: 1, same: true }
    });
    const picked = await pickVerifiedCandidate(
      page,
      [
        { kind: "click_selector", target: '[data-test="a"' },
        { kind: "click_text", target: "Save" }
      ],
      element
    );
    expect(picked).toEqual({ kind: "click_text", target: "Save" });
  });

  it("skips a candidate that resolves to nothing", async () => {
    const page = makeVerifyStubPage({
      "[data-test=\"gone\"]": { count: 0 },
      Save: { count: 1, same: true }
    });
    const picked = await pickVerifiedCandidate(
      page,
      [
        { kind: "click_selector", target: '[data-test="gone"]' },
        { kind: "click_text", target: "Save" }
      ],
      element
    );
    expect(picked).toEqual({ kind: "click_text", target: "Save" });
  });
});

describe("collectHitAtPoint and resolveDemoPointAction", () => {
  function makePointStubPage(opts: {
    walkResult: "element" | "iframe" | "offscreen" | "none";
    serialized?: DemoHit;
    verify?: Record<string, { count?: number; same?: boolean }>;
  }) {
    const disposed: string[] = [];
    const elementStub = {
      evaluate: async () => opts.serialized,
      dispose: async () => {
        disposed.push("element");
      }
    };
    const verifyPage = makeVerifyStubPage(opts.verify ?? {});
    return {
      page: {
        ...verifyPage,
        evaluateHandle: async () =>
          opts.walkResult === "element"
            ? { asElement: () => elementStub }
            : {
                asElement: () => null,
                jsonValue: async () => opts.walkResult,
                dispose: async () => {
                  disposed.push("handle");
                }
              }
      },
      disposed
    };
  }

  it("serializes the interactive element under the point", async () => {
    const serialized = hit({ tag: "a", text: "More information...", href: "/more" });
    const { page } = makePointStubPage({ walkResult: "element", serialized });
    const res = await collectHitAtPoint(page, 100, 80);
    expect(res.reason).toBeNull();
    expect(res.hit).toEqual(serialized);
    expect(res.element).not.toBeNull();
  });

  it("refuses an iframe hit by name (its content is another document)", async () => {
    const { page, disposed } = makePointStubPage({ walkResult: "iframe" });
    const resolved = await resolveDemoPointAction(page, {
      kind: "click_point",
      x: 10,
      y: 10,
      value: ""
    });
    expect(resolved).toEqual({ ok: false, reason: "iframe_content" });
    expect(disposed).toEqual(["handle"]);
  });

  it("names an offscreen point rather than calling it non-interactive silently", async () => {
    const { page } = makePointStubPage({ walkResult: "offscreen" });
    const resolved = await resolveDemoPointAction(page, {
      kind: "click_point",
      x: 10,
      y: 10,
      value: ""
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("not_interactive");
    expect(resolved.detail).toContain("outside");
  });

  it("resolves, verifies and records a click as an engine action, then disposes the handle", async () => {
    const { page, disposed } = makePointStubPage({
      walkResult: "element",
      serialized: hit({ tag: "button", dataTest: "note-open", text: "Open notes" }),
      verify: { '[data-test="note-open"]': { count: 1, same: true } }
    });
    const resolved = await resolveDemoPointAction(page, {
      kind: "click_point",
      x: 10,
      y: 10,
      value: ""
    });
    expect(resolved).toEqual({
      ok: true,
      action: { kind: "click_selector", target: '[data-test="note-open"]', value: "", optional: false },
      label: "Open notes"
    });
    expect(disposed).toEqual(["element"]);
  });

  it("carries the typed value onto a verified fill", async () => {
    const { page } = makePointStubPage({
      walkResult: "element",
      serialized: hit({ tag: "textarea", name: "message" }),
      verify: { 'textarea[name="message"]': { count: 1, same: true } }
    });
    const resolved = await resolveDemoPointAction(page, {
      kind: "fill_point",
      x: 10,
      y: 10,
      value: "Still trying to reach you"
    });
    expect(resolved).toEqual({
      ok: true,
      action: {
        kind: "fill_selector",
        target: 'textarea[name="message"]',
        value: "Still trying to reach you",
        optional: false
      },
      label: 'textarea[name="message"]'
    });
  });

  it("reports ambiguous when no candidate resolves back to the clicked element", async () => {
    const { page } = makePointStubPage({
      walkResult: "element",
      serialized: hit({ tag: "button", text: "Edit" }),
      verify: { Edit: { count: 1, same: false } }
    });
    const resolved = await resolveDemoPointAction(page, {
      kind: "click_point",
      x: 10,
      y: 10,
      value: ""
    });
    expect(resolved).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("surfaces a select hit with the choices it offers", async () => {
    const { page } = makePointStubPage({
      walkResult: "element",
      serialized: hit({ tag: "select", name: "reminderHour", options: ["9", "10", "11"] })
    });
    const resolved = await resolveDemoPointAction(page, {
      kind: "click_point",
      x: 10,
      y: 10,
      value: ""
    });
    expect(resolved).toEqual({
      ok: false,
      reason: "select_needs_option",
      options: ["9", "10", "11"]
    });
  });
});

describe("the in-page hit-test source", () => {
  it("scrolls with behavior instant, so smooth-scroll pages cannot race the hit-test", () => {
    // Bugbot, PR #1550: two-argument window.scrollTo respects CSS
    // `scroll-behavior: smooth`, so the scroll could still be animating when
    // scrollX / elementFromPoint read, and a below-the-fold click would be
    // reported offscreen or resolve to the wrong node. The in-page function
    // only runs in a real browser, so its source is what a unit test can pin.
    const demoSource = readFileSync(
      new URL("../vps/aiflow-render/demo.mjs", import.meta.url),
      "utf8"
    );
    expect(demoSource).toContain('behavior: "instant"');
    expect(demoSource).not.toMatch(/window\.scrollTo\((?!\{)/);
  });
});

describe("per-turn diagnostics slicing", () => {
  it("returns only what arrived since the marks were taken", () => {
    const diag: Record<string, string[]> = {
      consoleErrors: ["a", "b"],
      failedRequests: ["x"],
      pageErrors: [],
      dataServedAsMarkup: []
    };
    const marks = diagnosticsMarks(diag);
    expect(marks).toEqual({
      consoleErrors: 2,
      failedRequests: 1,
      pageErrors: 0,
      dataServedAsMarkup: 0
    });
    diag.consoleErrors.push("c");
    diag.pageErrors.push("boom");
    expect(sliceDiagnostics(diag, marks)).toEqual({
      consoleErrors: ["c"],
      pageErrors: ["boom"]
    });
  });

  it("answers null for a quiet turn and for a missing collector", () => {
    const diag = { consoleErrors: ["a"], failedRequests: [], pageErrors: [], dataServedAsMarkup: [] };
    expect(sliceDiagnostics(diag, diagnosticsMarks(diag))).toBeNull();
    expect(sliceDiagnostics(null, {})).toBeNull();
  });

  it("treats missing marks as zero (the start turn returns everything)", () => {
    const diag = { consoleErrors: ["a"], failedRequests: [], pageErrors: [], dataServedAsMarkup: [] };
    expect(sliceDiagnostics(diag, {})).toEqual({ consoleErrors: ["a"] });
  });
});
