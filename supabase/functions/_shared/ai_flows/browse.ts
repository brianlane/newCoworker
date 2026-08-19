/**
 * AiFlows browse helpers: SSRF-safe URL normalization + the render-service
 * contract. PURE (no IO) so it is unit-tested; the ai-flow-worker performs the
 * actual fetch.
 *
 * Phase-0 spike decision: the default browse backend is a STATIC fetch of the
 * (public) lead page. The contract here also describes an optional external
 * render service (`AIFLOW_RENDER_URL_TEMPLATE`, resolved per-tenant) so a heavier
 * headless backend (the self-hosted Playwright service in vps/aiflow-render) can be swapped in
 * for SPA / login-gated pages WITHOUT touching the engine, the worker just
 * POSTs `{ url }` (plus `businessId`+`auth` for credentialed browse) and gets
 * back `{ finalUrl, text, html }`.
 *
 * Every URL the worker fetches (directly or via the render service) MUST pass
 * `normalizeBrowseUrl` first so a malicious lead link can't point the fetcher at
 * cloud metadata / LAN hosts.
 */

/** IPv4 dotted-quad classification: true = private/loopback/reserved (unsafe). */
function isPrivateIpv4Literal(host: string): boolean {
  // Caller gates on a 4-octet dotted-quad regex, so split always yields 4 parts.
  const parts = host.split(".").map((n) => Number(n));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * True when a hostname must NOT be fetched: loopback/localhost, cloud-metadata
 * names, `*.internal`, private IPv4 literals, and ALL IPv6 literals (blocked
 * conservatively, public browsing always has a DNS name).
 */
export function isUnsafeBrowseHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata" || h === "metadata.google.internal" || h.endsWith(".internal")) {
    return true;
  }
  if (h.includes(":")) return true; // IPv6 literal (URL.hostname is bracketless)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return isPrivateIpv4Literal(h);
  return false;
}

/**
 * Validate + normalize a URL for browsing. Returns the canonical string, or
 * null when the URL is unparseable, not http(s), or points at an unsafe host.
 */
export function normalizeBrowseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isUnsafeBrowseHost(url.hostname)) return null;
  return url.toString();
}

export type RenderResult = {
  finalUrl: string;
  text: string;
  html: string;
  /** Base64 JPEG page screenshot, present when the request asked for one. */
  screenshotBase64?: string;
};

/**
 * Coerce an external render-service JSON body into a `RenderResult`, or null if
 * it doesn't match the contract. Lets the worker treat a malformed render
 * response as a recoverable step failure instead of throwing.
 */
export function parseRenderResponse(body: unknown, requestedUrl: string): RenderResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const text = typeof b.text === "string" ? b.text : "";
  const html = typeof b.html === "string" ? b.html : "";
  if (!text && !html) return null;
  const finalUrl = typeof b.finalUrl === "string" && b.finalUrl ? b.finalUrl : requestedUrl;
  const screenshotBase64 =
    typeof b.screenshotBase64 === "string" && b.screenshotBase64 ? b.screenshotBase64 : undefined;
  return { finalUrl, text, html, ...(screenshotBase64 ? { screenshotBase64 } : {}) };
}

/**
 * Map a render-service error code to how the worker should treat it.
 *
 * The render service reports application-level failures in a 200 JSON body
 * (`{ error, detail }`) rather than an HTTP 5xx, because a per-tenant render
 * sidecar sits behind a Cloudflare Tunnel and Cloudflare REPLACES the body of
 * any origin 5xx with its own `error code: 502` page, so a 502 would erase the
 * structured error and the worker would misread a permanent failure as a
 * transient one and retry it. Classifying on the error code keeps that
 * distinction intact:
 *  - "login", bad creds / MFA / missing platform config (`login_failed`,
 *                  `auth_config_error`): a permanent setup error.
 *  - "action", a browse_action selector no longer matches (`action_failed`):
 *                  permanent (the page changed; retrying can't fix it).
 *  - "transient", navigation timeout / unknown (`render_failed`, anything else):
 *                  safe to retry.
 */
export function renderErrorKind(errCode: string): "login" | "action" | "transient" {
  if (errCode === "login_failed" || errCode === "auth_config_error") return "login";
  if (errCode === "action_failed") return "action";
  return "transient";
}

/** Extract the `{ error, detail }` pair from a render body, empty strings if absent. */
export function renderErrorFields(body: unknown): { error: string; detail: string } {
  if (!body || typeof body !== "object") return { error: "", detail: "" };
  const b = body as Record<string, unknown>;
  return {
    error: typeof b.error === "string" ? b.error : "",
    detail: typeof b.detail === "string" ? b.detail : ""
  };
}

/** Loop-over-list outcome when a browse_action carried `forEachLink`. */
export type ForEachSummary = {
  /** How many list links the service MATCHED (the pre-cap total, not visits). */
  items: number;
  /** Items whose full action sequence completed. */
  succeeded: number;
  /**
   * Items where navigation or an action failed (best-effort: loop continues).
   * Includes the capped tail (`remaining`), kept that way so an older worker
   * reading only items/succeeded/failed still sees the truncation as misses.
   */
  failed: number;
  /**
   * Items the service matched but never visited because the per-response cap
   * truncated the list. 0 on an older render service that doesn't report it,
   * which also (deliberately) disables pass chaining against that service.
   */
  remaining: number;
  /** Up to a few human-readable per-item failure reasons. */
  errors: string[];
};

export type ActionRenderResult = {
  finalUrl: string;
  /** How many of the requested UI actions the service completed, in order. */
  actionsCompleted: number;
  /** Visible page text AFTER the actions ran (for same-pass field extraction). */
  text: string;
  /** Page HTML AFTER the actions ran (extraction fallback when text is empty). */
  html: string;
  /** Base64 JPEG captured AFTER the actions, when the request asked for one. */
  screenshotBase64?: string;
  /** Present only for a forEachLink loop; summarizes the per-item outcomes. */
  forEach?: ForEachSummary;
};

/**
 * Coerce a render-service ACTION-mode JSON body (`POST /render` with
 * `actions[]`) into an `ActionRenderResult`, or null when it doesn't match the
 * contract. `actionsCompleted` must be a non-negative number, it is how the
 * worker proves the click sequence actually ran. `text`/`html` are optional
 * (an older render service omits them) and default to "" so a browse_action
 * WITHOUT `fields` keeps working against any service version.
 */
export function parseActionResponse(body: unknown, requestedUrl: string): ActionRenderResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const completed = b.actionsCompleted;
  if (typeof completed !== "number" || !Number.isFinite(completed) || completed < 0) return null;
  const finalUrl = typeof b.finalUrl === "string" && b.finalUrl ? b.finalUrl : requestedUrl;
  const text = typeof b.text === "string" ? b.text : "";
  const html = typeof b.html === "string" ? b.html : "";
  const screenshotBase64 =
    typeof b.screenshotBase64 === "string" && b.screenshotBase64 ? b.screenshotBase64 : undefined;
  const forEach = parseForEach(b.forEach);
  return {
    finalUrl,
    actionsCompleted: Math.floor(completed),
    text,
    html,
    ...(screenshotBase64 ? { screenshotBase64 } : {}),
    ...(forEach ? { forEach } : {})
  };
}

/** Coerce a render `forEach` summary, or null when absent/malformed. */
function parseForEach(raw: unknown): ForEachSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  const items = num(f.items);
  const succeeded = num(f.succeeded);
  const failed = num(f.failed);
  if (items === null || succeeded === null || failed === null) return null;
  // Absent on an older render service → 0 (no chaining). The service counts
  // the capped tail inside `failed` too, so a body claiming more remaining
  // than failed is malformed; clamp rather than let the arithmetic go
  // negative downstream.
  const remaining = Math.min(num(f.remaining) ?? 0, failed);
  const errors = Array.isArray(f.errors)
    ? f.errors.filter((e): e is string => typeof e === "string").slice(0, 20)
    : [];
  return { items, succeeded, failed, remaining, errors };
}

/**
 * Cross-pass bookkeeping for a chained forEachLink sweep, JSON-encoded into a
 * `__foreach_<stepId>` context var so it survives the defer between passes.
 */
export type ForEachProgress = {
  /** Passes completed so far (each pass is one render-service request). */
  passes: number;
  /** Cumulative items whose action sequence completed, across all passes. */
  updated: number;
  /**
   * Items still listed after the LAST completed pass: its `items - succeeded`,
   * i.e. the capped tail PLUS that pass's per-card failures (failed cards
   * stay in the list too). The best "left" figure available if a later pass
   * dies before reporting; counting only the capped tail here would repeat
   * the exact undercount the measured alert exists to stop.
   */
  lastLeft: number;
};

/** Context var holding a step's in-flight chained-sweep progress. */
export function forEachProgressVar(stepId: string): string {
  return `__foreach_${stepId}`;
}

/** Encode progress for the context var. */
export function encodeForEachProgress(p: ForEachProgress): string {
  return JSON.stringify(p);
}

/** Decode progress from a context var; null when absent or malformed. */
export function parseForEachProgress(raw: unknown): ForEachProgress | null {
  if (typeof raw !== "string" || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  const passes = num(p.passes);
  const updated = num(p.updated);
  const lastLeft = num(p.lastLeft);
  if (passes === null || updated === null || lastLeft === null) return null;
  return { passes, updated, lastLeft };
}

/**
 * Names of the vars a forEachLink browse step publishes for LATER steps once
 * the sweep ends: how many list items it updated in total, and how many were
 * still listed when it stopped. The authoring-side validator and the builder
 * palette (`src/lib/ai-flows/schema.ts` / `tree.ts`) import THIS function, so
 * a flow can template `{{vars.<id>_updated}}`/`{{vars.<id>_left}}` and the
 * names can never drift from what the worker writes.
 */
export function forEachOutcomeVars(stepId: string): [updated: string, left: string] {
  return [`${stepId}_updated`, `${stepId}_left`];
}

/** The published vars with their values, for the worker's terminal write. */
export function forEachResultVars(
  stepId: string,
  outcome: { updated: number; left: number }
): Record<string, string> {
  const [updatedVar, leftVar] = forEachOutcomeVars(stepId);
  return {
    [updatedVar]: String(outcome.updated),
    [leftVar]: String(outcome.left)
  };
}

/**
 * What the worker should do after one forEachLink pass.
 *
 * Every terminal condition is NAMED so the run log can say why the loop
 * stopped instead of leaving a count mismatch to be reverse-engineered:
 *  - "list_drained": the pass saw the whole remaining list (no cap overflow).
 *    `left` is the real failures still sitting in the list, usually 0.
 *  - "no_progress": a full pass succeeded on nothing while items remained
 *    beyond the cap. The head of the list is stuck (cards whose page won't
 *    take the update), and re-listing would hand back the same head forever.
 *  - "pass_cap": the safety valve fired (maxPasses); a runaway list (or a
 *    portal that re-lists updated cards after all) must not loop for hours.
 *  - "lost_list": the list came back EMPTY while the previous pass said work
 *    was still owed. An empty list is normally the finish line, but it cannot
 *    be one step after "24 still waiting", so this is a lost session or a
 *    dead link, not a completed sweep. `left` reports what was still owed.
 */
export type ForEachDecision =
  | { kind: "fail_collect"; error: string }
  | { kind: "fail_first_pass"; attempted: number; error: string }
  | { kind: "continue"; progress: ForEachProgress }
  | {
      kind: "done";
      passes: number;
      updated: number;
      left: number;
      terminal: "list_drained" | "no_progress" | "pass_cap" | "lost_list";
    };

/**
 * Decide whether a chained sweep continues, finishes, or fails after a pass.
 *
 * Chaining exists because the whole loop must fit ONE HTTP response behind a
 * ~100s Cloudflare Tunnel timeout, so the render service caps each pass (6 by
 * default) and reports what it could not visit as `remaining`. Updated cards
 * leave the portal's "Needs Action" list (verified live 2026-08-18 on Amy's
 * Clever book), so re-running the same step gets the NEXT slice of the
 * backlog; the worker defers between passes and re-enters the same step until
 * nothing is left. Cards that fail keep their place in the list, which is why
 * they are retried on later passes and why a pass with zero successes ends
 * the loop instead of spinning on the same stuck head.
 */
export function decideForEach(
  fe: ForEachSummary,
  prior: ForEachProgress | null,
  maxPasses: number
): ForEachDecision {
  const passes = (prior?.passes ?? 0) + 1;
  const updated = (prior?.updated ?? 0) + fe.succeeded;
  const left = fe.items - fe.succeeded;
  if (fe.items === 0 && fe.errors.length > 0) {
    return { kind: "fail_collect", error: fe.errors[0] };
  }
  if (fe.items === 0) {
    // An empty list CONTRADICTS a previous pass that reported work still owed,
    // and the contradiction is the tell that we stopped seeing the list rather
    // than finished it. Amy's Clever portal is reached through a single-use
    // magic link; navigating it a second time renders "Magic link has expired",
    // a page with no list rows and no error, which is indistinguishable from
    // "all done" on the numbers alone (observed live 2026-08-19). Reporting the
    // previous pass's leftover keeps the owner alert truthful instead of
    // closing a half-finished sweep as clean.
    if (prior && prior.lastLeft > 0) {
      return { kind: "done", passes, updated, left: prior.lastLeft, terminal: "lost_list" };
    }
    return { kind: "done", passes, updated, left: 0, terminal: "list_drained" };
  }
  if (fe.succeeded === 0 && passes === 1) {
    // Nothing was applied, so failing the run is retry-safe, and a selector
    // or portal that broke for EVERY card must stay loud (today's semantics).
    return { kind: "fail_first_pass", attempted: fe.items - fe.remaining, error: fe.errors[0] ?? "" };
  }
  if (fe.remaining === 0) {
    return { kind: "done", passes, updated, left, terminal: "list_drained" };
  }
  if (fe.succeeded === 0) {
    return { kind: "done", passes, updated, left, terminal: "no_progress" };
  }
  if (passes >= maxPasses) {
    return { kind: "done", passes, updated, left, terminal: "pass_cap" };
  }
  return {
    kind: "continue",
    progress: { passes, updated, lastLeft: left }
  };
}
