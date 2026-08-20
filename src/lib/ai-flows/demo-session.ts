/**
 * "Teach it by doing it once": drive a live demonstration session on the
 * tenant's render sidecar, one interaction per call, and hand back what each
 * interaction RECORDED (a normal browse action) plus the page as it now
 * stands (digest, text, screenshot, diagnostics).
 *
 * This is the third authoring surface, after the read-only page picker
 * (page-probe.ts) and the dry run (action-check.ts), and it exists for the
 * limitation both of those state to the owner: they judge a page AS LOADED,
 * so a control that only appears after an earlier click can be neither
 * picked nor verified. A demonstration clicks for real, so it can walk a
 * wizard, and every recorded action was proven to work once by the exact
 * engine that will replay it.
 *
 * LIVE, by design: /demo/act performs the interaction on the vendor's real
 * page under the tenant's real login. The sidecar holds a confirm gate over
 * destructive-looking labels, and credentials are resolved sidecar-side from
 * an integration LABEL, never handled here.
 *
 * The demo endpoints are their OWN PATHS on the sidecar (the checkOnly
 * lesson): an un-redeployed box answers 404, mapped here to `not_updated`,
 * while an expired or restarted SESSION answers HTTP 200 `unknown_demo`,
 * mapped to the `demo_gone` outcome. The two must never blur, because their
 * remedies are different people ("ask us to update it" vs "start again").
 */
import { logger } from "@/lib/logger";
import { isProbeableUrl, resolveRenderProbeUrl } from "@/lib/ai-flows/page-probe";
import { digestPageControls } from "@/lib/ai-flows/page-controls";
import type { PageDiagnostics } from "@/lib/ai-flows/action-check-view";
import {
  DEMO_RESOLVE_FAILURE_REASONS,
  type DemoActOutcome,
  type DemoActRequestAction,
  type DemoRecordedAction,
  type DemoResolveFailureReason,
  type DemoTurnState
} from "@/lib/ai-flows/demo-session-view";

// Re-exported so server callers have one import site, while the "use client"
// panel imports the view module directly (this file reaches next/headers).
export {
  DEMO_ACTION_CAP_MESSAGE,
  DEMO_GONE_MESSAGE,
  DEMO_LIVE_WARNING,
  DEMO_REMOVE_WARNING,
  MAX_DEMO_ACTIONS,
  describeDemoResolveFailure,
  isConfirmLabel,
  toEditorActions,
  type DemoActOutcome,
  type DemoActRequestAction,
  type DemoRecordedAction,
  type DemoResolveFailureReason,
  type DemoTurnState
} from "@/lib/ai-flows/demo-session-view";

export type DemoStartFailure =
  | "not_configured"
  | "unsafe_url"
  | "not_updated"
  | "render_failed"
  | "login_failed"
  | "demo_limit";

export type DemoStartResult =
  | ({ ok: true; demoId: string; loggedIn: boolean } & DemoTurnState)
  | { ok: false; error: DemoStartFailure; detail?: string };

/**
 * Transport-level failures of an act/stop call. Everything that is a normal
 * TURN of the demonstration (needs_confirm, resolve_failed, action_failed,
 * demo_gone, action_cap) comes back as ok: true with an `outcome`, because
 * the panel continues the conversation on all of them.
 */
export type DemoActFailure = "not_configured" | "not_updated" | "render_failed";

export type DemoActResult =
  | ({ ok: true } & DemoActOutcome)
  | { ok: false; error: DemoActFailure; detail?: string };

export type DemoStopFailure = "not_configured" | "not_updated" | "render_failed";

export type DemoStopResult =
  | { ok: true; actionsCount?: number }
  | { ok: false; error: DemoStopFailure; detail?: string };

export type DemoSessionDeps = {
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** The sidecar demo endpoint for a tenant, derived off the /render template. */
function demoEndpoint(businessId: string, path: "start" | "act" | "stop"): string | null {
  const base = resolveRenderProbeUrl(businessId);
  if (!base) return null;
  return `${base.replace(/\/render\/?$/, "").replace(/\/+$/, "")}/demo/${path}`;
}

function bearerHeaders(): Record<string, string> {
  const token = (process.env.AIFLOW_RENDER_TOKEN ?? "").trim();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

type SidecarBody = Record<string, unknown> | null;

/**
 * POST one demo request. Returns the parsed body, or a classified failure.
 * 404 is the stale-box answer by contract, so it is named rather than folded
 * into render_failed.
 */
async function postDemo(
  endpoint: string,
  payload: unknown,
  deps: DemoSessionDeps
): Promise<{ ok: true; body: SidecarBody } | { ok: false; error: "not_updated" | "render_failed"; detail?: string }> {
  /* c8 ignore next -- production default; tests inject fetchImpl */
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  /* c8 ignore next -- timer fires only on a real sidecar hang */
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 120_000);
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: bearerHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (res.status === 404) return { ok: false, error: "not_updated" };
    if (!res.ok) return { ok: false, error: "render_failed", detail: `sidecar http ${res.status}` };
    const body = (await res.json().catch(() => null)) as SidecarBody;
    return { ok: true, body };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("demo-session: sidecar call failed", { endpoint, error: detail.slice(0, 300) });
    return { ok: false, error: "render_failed", detail: detail.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/** The page-state fields of a sidecar body, digested for the panel. */
function turnStateOf(body: Record<string, unknown>, fallbackUrl: string): DemoTurnState {
  const html = typeof body.html === "string" ? body.html : "";
  return {
    finalUrl: typeof body.finalUrl === "string" ? body.finalUrl : fallbackUrl,
    digest: digestPageControls(html),
    pageText: typeof body.text === "string" ? body.text : "",
    ...(typeof body.screenshotBase64 === "string" && body.screenshotBase64.length > 0
      ? { screenshotBase64: body.screenshotBase64 }
      : {}),
    ...(body.diagnostics && typeof body.diagnostics === "object"
      ? { diagnostics: body.diagnostics as PageDiagnostics }
      : {})
  };
}

function recordedOf(raw: unknown): DemoRecordedAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as { kind?: unknown; target?: unknown; value?: unknown };
  if (typeof a.kind !== "string" || typeof a.target !== "string") return null;
  return {
    kind: a.kind,
    target: a.target,
    ...(typeof a.value === "string" ? { value: a.value } : {})
  };
}

/**
 * Open a demonstration session on `url`, logging in via the named integration
 * when given. Success carries the first turn's page state and the demoId
 * every later call needs.
 */
export async function startBrowseDemo(
  businessId: string,
  url: string,
  opts: { integrationLabel?: string } & DemoSessionDeps = {}
): Promise<DemoStartResult> {
  if (!isProbeableUrl(url)) {
    return { ok: false, error: "unsafe_url", detail: "The address must be a public http(s) page." };
  }
  const endpoint = demoEndpoint(businessId, "start");
  if (!endpoint) return { ok: false, error: "not_configured" };
  const sent = await postDemo(
    endpoint,
    {
      businessId,
      url,
      ...(opts.integrationLabel ? { auth: { integrationLabel: opts.integrationLabel } } : {})
    },
    opts
  );
  if (!sent.ok) return { ok: false, error: sent.error, ...(sent.detail ? { detail: sent.detail } : {}) };
  const body = sent.body;
  if (body && typeof body.error === "string") {
    const detail = typeof body.detail === "string" ? body.detail.slice(0, 300) : undefined;
    if (body.error === "login_failed") {
      return { ok: false, error: "login_failed", ...(detail ? { detail } : {}) };
    }
    if (body.error === "demo_limit") {
      return { ok: false, error: "demo_limit", ...(detail ? { detail } : {}) };
    }
    // auth_config_error and render_failed both mean "the page could not be
    // opened", and the detail says which (same fold as the page picker).
    return { ok: false, error: "render_failed", detail: detail ?? body.error };
  }
  if (!body || typeof body.demoId !== "string" || body.demoId.length === 0) {
    return { ok: false, error: "render_failed", detail: "malformed sidecar response" };
  }
  return {
    ok: true,
    demoId: body.demoId,
    loggedIn: body.loggedIn === true,
    ...turnStateOf(body, url)
  };
}

/**
 * Perform ONE demonstrated interaction. The sidecar executes it for real and
 * answers with what it recorded plus the page afterwards, or with one of the
 * conversation-turn outcomes (needs_confirm, resolve_failed, action_failed,
 * demo_gone, action_cap).
 */
export async function actBrowseDemo(
  businessId: string,
  demoId: string,
  action: DemoActRequestAction,
  opts: { confirm?: boolean } & DemoSessionDeps = {}
): Promise<DemoActResult> {
  const endpoint = demoEndpoint(businessId, "act");
  if (!endpoint) return { ok: false, error: "not_configured" };
  const sent = await postDemo(
    endpoint,
    { businessId, demoId, action, ...(opts.confirm ? { confirm: true } : {}) },
    opts
  );
  if (!sent.ok) return { ok: false, error: sent.error, ...(sent.detail ? { detail: sent.detail } : {}) };
  const body = sent.body;
  if (body && typeof body.error === "string") {
    const detail = typeof body.detail === "string" ? body.detail.slice(0, 600) : undefined;
    switch (body.error) {
      case "unknown_demo":
        // Expired, restarted box, or a stale id: the session is gone, the
        // recording (client-side) is not.
        return { ok: true, outcome: "demo_gone" };
      case "demo_gone":
        return { ok: true, outcome: "demo_gone", ...(detail ? { detail } : {}) };
      case "action_cap":
        return { ok: true, outcome: "action_cap" };
      case "needs_confirm": {
        const resolved = recordedOf(body.resolved);
        if (!resolved) {
          return { ok: false, error: "render_failed", detail: "malformed sidecar response" };
        }
        return {
          ok: true,
          outcome: "needs_confirm",
          resolved,
          label: typeof body.label === "string" && body.label.length > 0 ? body.label : resolved.target
        };
      }
      case "resolve_failed": {
        const reason =
          typeof body.reason === "string" &&
          DEMO_RESOLVE_FAILURE_REASONS.has(body.reason as DemoResolveFailureReason)
            ? (body.reason as DemoResolveFailureReason)
            : null;
        if (!reason) {
          return { ok: false, error: "render_failed", detail: "malformed sidecar response" };
        }
        return {
          ok: true,
          outcome: "resolve_failed",
          reason,
          ...(detail ? { detail } : {}),
          ...(Array.isArray(body.options)
            ? { options: body.options.filter((o): o is string => typeof o === "string").slice(0, 40) }
            : {})
        };
      }
      case "action_failed":
        return {
          ok: true,
          outcome: "action_failed",
          detail: detail ?? "the action could not be performed",
          // The after-state rides along so the owner can SEE where it stuck.
          ...turnStateOf(body, "")
        };
      default:
        return { ok: false, error: "render_failed", detail: detail ?? body.error };
    }
  }
  const recorded = recordedOf(body?.recorded);
  if (!body || !recorded || typeof body.actionsCount !== "number") {
    return { ok: false, error: "render_failed", detail: "malformed sidecar response" };
  }
  return {
    ok: true,
    outcome: "recorded",
    recorded,
    actionsCount: body.actionsCount,
    ...turnStateOf(body, "")
  };
}

/** End a session. Idempotent on the sidecar; a missing session is still ok. */
export async function stopBrowseDemo(
  businessId: string,
  demoId: string,
  opts: DemoSessionDeps = {}
): Promise<DemoStopResult> {
  const endpoint = demoEndpoint(businessId, "stop");
  if (!endpoint) return { ok: false, error: "not_configured" };
  const sent = await postDemo(endpoint, { businessId, demoId }, opts);
  if (!sent.ok) return { ok: false, error: sent.error, ...(sent.detail ? { detail: sent.detail } : {}) };
  const body = sent.body;
  if (body && typeof body.error === "string") {
    const detail = typeof body.detail === "string" ? body.detail.slice(0, 300) : undefined;
    return { ok: false, error: "render_failed", detail: detail ?? body.error };
  }
  if (!body || body.ok !== true) {
    return { ok: false, error: "render_failed", detail: "malformed sidecar response" };
  }
  return {
    ok: true,
    ...(typeof body.actionsCount === "number" ? { actionsCount: body.actionsCount } : {})
  };
}
