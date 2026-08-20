/**
 * DEMONSTRATION mode for the AiFlow render service: teach a browse step by
 * doing the workflow once.
 *
 * The page picker and the dry run both judge a page AS LOADED, so a control
 * that only exists after an earlier click (a wizard, a modal, a drawer) can
 * neither be picked nor verified. Demonstration mode closes that gap: the
 * owner drives a LIVE page in this service's own browser, one interaction per
 * request, and every interaction is recorded as a normal browse action
 * ({ kind, target, value }) that the flow engine can replay verbatim. Each
 * recorded action is executed here via the exact same runAction the engine
 * uses, so a recording is proven to work at least once by construction.
 *
 * This module owns the parts that can be unit-tested without a browser
 * (tests/aiflow-render-demo.test.ts): the session store, action parsing, the
 * point-to-action derivation, candidate verification, and per-turn
 * diagnostics slicing. server.mjs owns the HTTP handlers, the browser pool,
 * and login, same split as actions.mjs and login.mjs.
 *
 * Sessions here are DEMO sessions (a persistent page the owner is driving),
 * not the per-tenant auth contexts server.mjs caches. A demo session holds
 * one of those context entries refcounted for its whole life, which is why
 * `release` being exactly-once matters: a leaked hold pins the context
 * forever (evictStale never touches inUse > 0). Every exit path funnels
 * through the store's idempotent release, and the sweep releases
 * unconditionally at the hard lifetime.
 */
import { ACTION_KINDS, locateActionTarget, parseActions } from "./actions.mjs";

/** Idle eviction for a demo session: the owner walked away mid-demo. */
export const DEMO_IDLE_TTL_MS = Number(process.env.AIFLOW_DEMO_IDLE_TTL_MS ?? 5 * 60 * 1000);
/** Hard lifetime cap, releases even a busy session so a hold can never leak. */
export const DEMO_MAX_LIFETIME_MS = Number(
  process.env.AIFLOW_DEMO_MAX_LIFETIME_MS ?? 20 * 60 * 1000
);
/**
 * Concurrent demo sessions per box. Each one is a persistent Chromium page
 * held open between requests, priced against the container's 1536m limit.
 * The box is per-tenant, so 2 is "an owner and a second tab", not a fleet.
 */
export const DEMO_MAX_SESSIONS = Number(process.env.AIFLOW_DEMO_MAX_SESSIONS ?? 2);
export const DEMO_SWEEP_INTERVAL_MS = Number(
  process.env.AIFLOW_DEMO_SWEEP_INTERVAL_MS ?? 60_000
);
/** Cap on the visible-text excerpt each turn returns (the html rides separately). */
export const DEMO_TEXT_MAX_CHARS = Number(process.env.AIFLOW_DEMO_TEXT_MAX_CHARS ?? 20_000);
/** Bounds on a point action's coordinates and a fill's typed value. */
export const DEMO_POINT_MAX = 20_000;
export const DEMO_VALUE_MAX_CHARS = 2_000;
/**
 * How long candidate verification waits for a derived selector to resolve.
 * The element is ALREADY on the page (the owner just clicked its picture), so
 * a candidate that cannot resolve quickly is a wrong candidate, not a slow one.
 */
export const DEMO_VERIFY_TIMEOUT_MS = Number(process.env.AIFLOW_DEMO_VERIFY_TIMEOUT_MS ?? 2_000);

/**
 * Labels that commit the tenant to something rather than merely navigating.
 * Ported VERBATIM from debug/portal-dom-probe.ts (DESTRUCTIVE_TARGETS), and a
 * lockstep test pins the two sources together. The engineer probe REFUSES
 * these; a demonstration instead requires an explicit confirm, because
 * clicking "Accept" may be the very workflow being taught. The gate lives
 * here, sidecar-side, so no dashboard bug can click a claim button silently.
 */
export const CONFIRM_LABEL_RE =
  /decline|claim|submit|accept|delete|remove|withdraw|send|pay|confirm|cancel|sign.?out|logout/i;

/**
 * Input types a demonstrated fill may type into. A DUPLICATE of
 * TYPEABLE_INPUT_TYPES in src/lib/ai-flows/page-controls.ts (this file is
 * plain .mjs shipped to the box and cannot import app TypeScript); a lockstep
 * test pins the two. `password` is absent on purpose, and the point path is
 * exactly why the copy must exist here: a click on the SCREENSHOT bypasses
 * the app-side digest entirely, so the app's allowlist alone would not stop a
 * demonstrated credential fill.
 */
export const DEMO_TYPEABLE_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week"
]);

/**
 * Action kinds /demo/act accepts. Everything the schema knows EXCEPT
 * click_text_while_present: a demo turn is one interaction, and a bounded
 * click-loop is an autonomous behavior, not a demonstration. The owner can
 * click a wizard button repeatedly, one turn each, or author the loop kind by
 * hand in the editor afterwards.
 */
export const DEMO_ACT_KINDS = new Set(
  [...ACTION_KINDS].filter((kind) => kind !== "click_text_while_present")
);

/**
 * Ids stable enough to record as selectors: letters and hyphens only. A digit
 * is treated as a build-hash tell (SPA frameworks mint ids like `radix-:r1:`
 * or `button-3f9a`), and a selector recorded off one breaks on the vendor's
 * next deploy, which is precisely the failure mode demonstrations exist to
 * end. A control that only has a hashy id falls back to the control list.
 */
export const STABLE_ID_RE = /^[A-Za-z][A-Za-z-]*$/;

/**
 * Normalize and validate one /demo/act action. Standard kinds go through the
 * engine's own parseActions so a recorded action can never be shaped
 * differently from a replayed one; `optional` is stripped because a
 * demonstration must fail loudly when its target is missing, never skip.
 * Point kinds carry screenshot coordinates in document-space CSS pixels.
 * Returns null when malformed.
 */
export function parseDemoAction(raw) {
  const kind = String(raw?.kind ?? "");
  if (kind === "click_point" || kind === "fill_point") {
    const x = Number(raw?.x);
    const y = Number(raw?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || y < 0 || x > DEMO_POINT_MAX || y > DEMO_POINT_MAX) return null;
    const value = raw?.value === undefined ? "" : String(raw.value);
    if (value.length > DEMO_VALUE_MAX_CHARS) return null;
    return { kind, x: Math.round(x), y: Math.round(y), value };
  }
  if (!DEMO_ACT_KINDS.has(kind)) return null;
  const parsed = parseActions([raw]);
  if (!parsed) return null;
  return { ...parsed[0], optional: false };
}

// Kinds whose `value` is a label the owner is choosing (an ARIA name, an
// option), so the confirm gate must read it too: choosing "Remove" from a
// dropdown commits exactly like clicking a Remove button.
const CONFIRM_VALUE_KINDS = new Set(["click_role", "select_option"]);

/** Does this resolved action need an explicit confirm before it executes? */
export function isConfirmRequired(action) {
  if (CONFIRM_LABEL_RE.test(action.target)) return true;
  return CONFIRM_VALUE_KINDS.has(action.kind) && CONFIRM_LABEL_RE.test(action.value ?? "");
}

/**
 * The demo-session store. Pure bookkeeping with an injected clock so the TTL
 * arithmetic is unit-testable; the caller supplies each session's `close`
 * (page teardown plus context release), and the store guarantees it runs
 * EXACTLY once however many paths race to release.
 */
export function createDemoStore({
  now = () => Date.now(),
  idleTtlMs = DEMO_IDLE_TTL_MS,
  maxLifetimeMs = DEMO_MAX_LIFETIME_MS,
  maxSessions = DEMO_MAX_SESSIONS
} = {}) {
  const sessions = new Map(); // demoId -> session

  async function release(session) {
    if (!session || session.released) return;
    session.released = true;
    sessions.delete(session.demoId);
    try {
      await session.close();
    } catch {
      // Releasing must never throw: the session is gone either way, and the
      // sweep that calls this cannot be allowed to die on one bad page.
    }
  }

  /**
   * Register a session, or return null when the box is full. At the cap, the
   * OLDEST session for the SAME business is evicted first: boxes are
   * per-tenant, so the common collision is an owner retrying after a start
   * that timed out at the tunnel, and refusing them over their own leaked
   * half-session would make the failure sticky.
   */
  async function create({ demoId, businessId, page, close }) {
    if (sessions.size >= maxSessions) {
      const sameBusiness = [...sessions.values()]
        .filter((s) => s.businessId === businessId)
        .sort((a, b) => a.createdAt - b.createdAt);
      if (sameBusiness.length > 0) await release(sameBusiness[0]);
    }
    if (sessions.size >= maxSessions) return null;
    const t = now();
    const session = {
      demoId,
      businessId,
      page,
      close,
      createdAt: t,
      lastUsed: t,
      actionsCount: 0,
      released: false
    };
    sessions.set(demoId, session);
    return session;
  }

  /**
   * Look up a session by id AND business. A business mismatch answers exactly
   * like an unknown id, so a replayed demoId from another tenant learns
   * nothing (the fleet bearer is shared; this binding is the defense in depth
   * behind it).
   */
  function get(demoId, businessId) {
    const session = sessions.get(demoId);
    if (!session || session.released) return null;
    if (session.businessId !== businessId) return null;
    return session;
  }

  function touch(session) {
    session.lastUsed = now();
  }

  async function sweep() {
    const t = now();
    for (const session of [...sessions.values()]) {
      if (t - session.lastUsed > idleTtlMs || t - session.createdAt > maxLifetimeMs) {
        await release(session);
      }
    }
  }

  function size() {
    return sessions.size;
  }

  return { create, get, touch, release, sweep, size };
}

/**
 * Hit-test a screenshot click against the live page and return the
 * interactive element under it.
 *
 * Coordinates are DOCUMENT-space CSS pixels: captureScreenshot clips from the
 * document origin at deviceScaleFactor 1, so image pixels equal document
 * coordinates and the panel only has to scale by the image's rendered size.
 * elementFromPoint works in VIEWPORT space, so the page is scrolled to bring
 * the point on screen first.
 *
 * Returns { reason, element, hit }: `element` is an ElementHandle for the
 * interactive ancestor (caller must dispose it) and `hit` its serialized
 * description, or element is null with `reason` one of "none" | "iframe" |
 * "offscreen". An <iframe> hit is refused rather than resolved: its content
 * is another document, and no selector recorded from the outer page can
 * address it.
 */
export async function collectHitAtPoint(page, x, y) {
  const handle = await page.evaluateHandle(
    ({ x, y }) => {
      const iw = window.innerWidth || 1280;
      const ih = window.innerHeight || 720;
      window.scrollTo(Math.max(0, x - iw / 2), Math.max(0, y - ih / 2));
      const vx = x - window.scrollX;
      const vy = y - window.scrollY;
      if (vx < 0 || vy < 0 || vx >= iw || vy >= ih) return "offscreen";
      const el = document.elementFromPoint(vx, vy);
      if (!el) return "none";
      if (el.tagName === "IFRAME") return "iframe";
      const sel =
        'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], ' +
        "input, select, textarea, summary, [onclick]";
      let hit = typeof el.closest === "function" ? el.closest(sel) : null;
      if (!hit) {
        // SVG nodes inside icon buttons: walk parentElement when closest is
        // not on the instance chain.
        let cur = el;
        while (cur && cur !== document.documentElement) {
          if (cur.matches && cur.matches(sel)) {
            hit = cur;
            break;
          }
          cur = cur.parentElement;
        }
      }
      return hit ?? "none";
    },
    { x, y }
  );
  const element = handle.asElement ? handle.asElement() : null;
  if (!element) {
    let reason = "none";
    try {
      const value = await handle.jsonValue();
      if (value === "iframe" || value === "offscreen") reason = value;
    } catch {
      // A dead handle reads as "none", which fails safe.
    }
    if (typeof handle.dispose === "function") await handle.dispose().catch(() => {});
    return { reason, element: null, hit: null };
  }
  const hit = await element.evaluate((el) => {
    const attr = (name) => el.getAttribute(name) ?? "";
    const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
    const tag = el.tagName.toLowerCase();
    return {
      tag,
      inputType: tag === "input" ? (attr("type") || "text").toLowerCase() : "",
      name: attr("name"),
      id: el.id ?? "",
      dataTest: attr("data-test"),
      dataTestId: attr("data-testid"),
      ariaLabel: collapse(attr("aria-label")).slice(0, 300),
      role: attr("role"),
      text: collapse(el.textContent).slice(0, 300),
      placeholder: attr("placeholder"),
      valueAttr: attr("value").slice(0, 300),
      disabled: el.disabled === true,
      href: tag === "a" ? attr("href") : "",
      options:
        tag === "select"
          ? [...el.querySelectorAll("option")]
              .map((o) => collapse(o.textContent) || o.getAttribute("value") || "")
              .filter(Boolean)
              .slice(0, 40)
          : undefined
    };
  });
  return { reason: null, element, hit };
}

/** A value safe inside a quoted CSS attribute selector (same rule as the app digest). */
function quotable(value) {
  return typeof value === "string" && value.length > 0 && !value.includes('"');
}

/**
 * Turn a hit-tested element into an ORDERED list of recordable action
 * candidates, or a verdict explaining why it cannot be recorded. Pure: this
 * is the unit-test surface for the whole derivation.
 *
 * Candidate order is durability order: the vendor's own data-test handle
 * first, then the control's visible/accessible name (what an owner reads),
 * then a plain letters-only id as the last resort. The FIRST candidate that
 * verifies against the actual hit element wins (pickVerifiedCandidate), so a
 * same-text twin elsewhere on the page rejects the text candidate and falls
 * through rather than recording a click on the wrong control.
 */
export function deriveDemoCandidates(hit, intent) {
  if (hit.tag === "select") {
    // A demonstrated dropdown needs a CHOICE, not a click; the panel routes
    // the owner to the option chips, which send a normal select_option act.
    return { verdict: "select_needs_option", options: hit.options ?? [] };
  }
  const isTextarea = hit.tag === "textarea";
  const isInput = hit.tag === "input";
  const typeable =
    isTextarea || (isInput && DEMO_TYPEABLE_INPUT_TYPES.has(hit.inputType || "text"));

  if (intent === "fill") {
    if (!typeable) return { verdict: "not_typeable" };
    const tag = isTextarea ? "textarea" : "input";
    const candidates = [];
    if (quotable(hit.name)) {
      candidates.push({ kind: "fill_selector", target: `${tag}[name="${hit.name}"]` });
    }
    if (hit.placeholder) {
      candidates.push({ kind: "fill_placeholder", target: hit.placeholder });
    }
    if (candidates.length === 0) return { verdict: "field_unaddressable" };
    return { verdict: "candidates", candidates, label: fieldLabel(hit, tag) };
  }

  // Click intent.
  if (typeable) return { verdict: "field_use_fill" };
  if (isInput && (hit.inputType === "password" || hit.inputType === "hidden" || hit.inputType === "file")) {
    return { verdict: "not_typeable" };
  }
  const candidates = [];
  if (quotable(hit.dataTest)) {
    candidates.push({ kind: "click_selector", target: `[data-test="${hit.dataTest}"]` });
  }
  if (quotable(hit.dataTestId)) {
    candidates.push({ kind: "click_selector", target: `[data-testid="${hit.dataTestId}"]` });
  }
  if (isInput && (hit.inputType === "checkbox" || hit.inputType === "radio")) {
    // Radios share a name by design, so name alone resolves to the first of
    // the group; the value attribute is what distinguishes the one clicked.
    if (quotable(hit.name) && quotable(hit.valueAttr)) {
      candidates.push({
        kind: "click_selector",
        target: `input[type="${hit.inputType}"][name="${hit.name}"][value="${hit.valueAttr}"]`
      });
    } else if (quotable(hit.name) && hit.inputType === "checkbox") {
      candidates.push({
        kind: "click_selector",
        target: `input[type="checkbox"][name="${hit.name}"]`
      });
    }
  }
  const label = hit.ariaLabel || hit.text || hit.valueAttr;
  if (label) candidates.push({ kind: "click_text", target: label.slice(0, 300) });
  if (STABLE_ID_RE.test(hit.id ?? "")) {
    candidates.push({ kind: "click_selector", target: `#${hit.id}` });
  }
  if (candidates.length === 0) return { verdict: "no_stable_selector" };
  return { verdict: "candidates", candidates, label: label || candidates[0].target };
}

/** What the owner reads back for a recorded fill ("the Message box"). */
function fieldLabel(hit, tag) {
  if (hit.placeholder) return `${tag} "${hit.placeholder}"`;
  if (hit.name) return `${tag}[name="${hit.name}"]`;
  return tag;
}

/**
 * Pick the first candidate whose engine-side resolution lands on the very
 * element the owner clicked. `element` is the hit's ElementHandle; identity
 * accepts containment either way because text strategies resolve to the
 * control while the hit may be a child span (or vice versa).
 *
 * A candidate resolving to a DIFFERENT element is the classic second-Edit-
 * button-in-a-table trap: the recording would replay against the first match,
 * not the demonstrated one, so it is skipped and the next strategy tried.
 * Returns null when nothing verifies (the act reports "ambiguous").
 */
export async function pickVerifiedCandidate(
  page,
  candidates,
  element,
  { timeoutMs = DEMO_VERIFY_TIMEOUT_MS } = {}
) {
  for (const candidate of candidates) {
    let loc;
    try {
      // appearTimeoutMs 0: the element is already on the page, so a strategy
      // that cannot resolve NOW is wrong, and waiting would spend the turn's
      // budget rejecting bad candidates instead of finding the good one.
      loc = await locateActionTarget(page, candidate, { appearTimeoutMs: 0 });
    } catch {
      continue;
    }
    if (!loc) continue;
    try {
      const same = await loc.evaluate(
        (el, target) => el === target || el.contains(target) || target.contains(el),
        element,
        { timeout: timeoutMs }
      );
      if (same) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolve a point action against the live page: hit-test, derive candidates,
 * verify each against the hit element, and return the recordable action.
 *
 * Returns { ok: true, action, label } or
 * { ok: false, reason, detail?, options? } with reason one of:
 *   not_interactive | iframe_content | select_needs_option | field_use_fill |
 *   not_typeable | field_unaddressable | no_stable_selector | ambiguous
 * Nothing is executed here; the caller applies the confirm gate and runs the
 * returned action through the normal engine.
 */
export async function resolveDemoPointAction(page, action) {
  const intent = action.kind === "fill_point" ? "fill" : "click";
  const { reason, element, hit } = await collectHitAtPoint(page, action.x, action.y);
  if (!element) {
    return {
      ok: false,
      reason: reason === "iframe" ? "iframe_content" : "not_interactive",
      ...(reason === "offscreen" ? { detail: "the point is outside the rendered page" } : {})
    };
  }
  try {
    const derived = deriveDemoCandidates(hit, intent);
    if (derived.verdict !== "candidates") {
      return {
        ok: false,
        reason: derived.verdict,
        ...(derived.options ? { options: derived.options } : {})
      };
    }
    const candidate = await pickVerifiedCandidate(page, derived.candidates, element);
    if (!candidate) return { ok: false, reason: "ambiguous" };
    const value = intent === "fill" ? String(action.value ?? "") : "";
    return {
      ok: true,
      action: { kind: candidate.kind, target: candidate.target, value, optional: false },
      label: derived.label ?? candidate.target
    };
  } finally {
    if (typeof element.dispose === "function") await element.dispose().catch(() => {});
  }
}

/**
 * Per-turn diagnostics: attachDiagnostics collects for the PAGE's lifetime,
 * and a demo page lives many turns, so each response slices off only what
 * arrived since its own turn began. Marks are per-array lengths taken at the
 * top of the turn.
 */
export function diagnosticsMarks(diag) {
  if (!diag) return {};
  const marks = {};
  for (const [key, value] of Object.entries(diag)) {
    marks[key] = Array.isArray(value) ? value.length : 0;
  }
  return marks;
}

/** The entries appended since `marks`, empty arrays dropped; null when quiet. */
export function sliceDiagnostics(diag, marks) {
  if (!diag) return null;
  const out = {};
  for (const [key, value] of Object.entries(diag)) {
    if (!Array.isArray(value)) continue;
    const from = Number(marks?.[key] ?? 0);
    const fresh = value.slice(from);
    if (fresh.length > 0) out[key] = fresh;
  }
  return Object.keys(out).length > 0 ? out : null;
}
