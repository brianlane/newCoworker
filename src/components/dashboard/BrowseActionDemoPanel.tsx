"use client";

/**
 * "Teach it by doing it once": the owner performs the workflow on the LIVE
 * page, inside the business's own browser, and every interaction is recorded
 * as a step action that replays verbatim.
 *
 * This is the third authoring surface, and the only one that acts. The page
 * picker shows what is on a page; the dry run proves a sequence resolves;
 * both judge the page AS LOADED, so anything behind a click (a wizard, a
 * modal) is out of their reach. A demonstration clicks for real, which is
 * exactly why the copy in here never softens: what happens here happens on
 * the real site, once, and removing a recorded step does not unhappen it.
 *
 * Two ways to interact each turn: click a control in the extracted list, or
 * click a point on the screenshot itself (the sidecar resolves the element
 * under it to a durable selector and refuses when it cannot). Typed text goes
 * through per-field inputs, never a live keystroke relay. Destructive-looking
 * labels are confirmed inline before anything is sent; the sidecar holds the
 * same gate structurally, so a point click the panel could not pre-read comes
 * back as needs_confirm instead of executing.
 */
import { useRef, useState } from "react";
import {
  AlertTriangle,
  CircleDot,
  GraduationCap,
  Plus,
  Sparkles,
  Trash2,
  Undo2
} from "lucide-react";
import type { PageControl, PageDigest } from "@/lib/ai-flows/page-controls";
import { PAGE_CONTROL_GROUPS } from "@/lib/ai-flows/page-controls";
import type { EditorAction, PageDiagnostics } from "@/lib/ai-flows/action-check-view";
import { describePageDiagnostics } from "@/lib/ai-flows/action-check-view";
// The VIEW module, not demo-session.ts: the server lib reaches next/headers
// and a value import from it here fails the build.
import {
  DEMO_ACTION_CAP_MESSAGE,
  DEMO_GONE_MESSAGE,
  DEMO_LIVE_WARNING,
  DEMO_REMOVE_WARNING,
  describeDemoResolveFailure,
  isConfirmLabel,
  MAX_DEMO_ACTIONS,
  toEditorActions,
  type DemoActRequestAction,
  type DemoRecordedAction,
  type DemoResolveFailureReason
} from "@/lib/ai-flows/demo-session-view";

type Props = {
  businessId: string;
  /** The step's saved login label, when the page is behind the owner's account. */
  integrationLabel?: string;
  /** How many actions the step already holds (append must fit the 15 cap). */
  existingActionsCount: number;
  /** Hand the recording to the step being edited. */
  onFinish: (actions: EditorAction[], mode: "replace" | "append") => void;
  /**
   * The palette's in-scope placeholders for this step, so the suggest call
   * can map typed literals to variables. The lib clamps against exactly this
   * list, and each mapping is an individually-accepted chip.
   */
  varsInScope: string[];
  /** Apply an accepted "Proof it worked" suggestion to the step. */
  onSetExpectText: (text: string) => void;
};

type TurnState = {
  finalUrl: string;
  digest: PageDigest;
  pageText: string;
  screenshotBase64?: string;
  diagnostics?: PageDiagnostics;
};

type ActData = {
  outcome?: string;
  recorded?: DemoRecordedAction;
  actionsCount?: number;
  finalUrl?: string;
  digest?: PageDigest;
  pageText?: string;
  screenshotBase64?: string;
  diagnostics?: PageDiagnostics;
  resolved?: DemoRecordedAction;
  label?: string;
  reason?: DemoResolveFailureReason;
  detail?: string;
  options?: string[];
};

type DemoSuggestions = {
  fills: { index: number; placeholder: string }[];
  expectText?: string;
};

const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1 text-xs text-parchment placeholder:text-parchment/30";

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function BrowseActionDemoPanel({
  businessId,
  integrationLabel,
  existingActionsCount,
  onFinish,
  varsInScope,
  onSetExpectText
}: Props) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [demoId, setDemoId] = useState<string | null>(null);
  const [turn, setTurn] = useState<TurnState | null>(null);
  const [recorded, setRecorded] = useState<DemoRecordedAction[]>([]);
  /** What the SIDECAR has performed this session; never decreases. */
  const [executedCount, setExecutedCount] = useState(0);
  const [removedMidList, setRemovedMidList] = useState(false);
  const [gone, setGone] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{
    action: DemoActRequestAction;
    label: string;
  } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [fillDrafts, setFillDrafts] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<DemoSuggestions | null>(null);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [acceptedExpect, setAcceptedExpect] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const live = demoId !== null && !gone;
  /**
   * TWO limits, and the higher one wins, because they diverge in both
   * directions:
   *
   *  - The SESSION's executed count. The sidecar counts what it actually
   *    performed, and removing a row cannot un-perform a click, so reading
   *    the local list alone would promise room and then hand the owner
   *    `action_cap` with no way out but abandoning the session.
   *  - The RECORDING's length. That is what gets SAVED, and a step holds at
   *    most MAX_DEMO_ACTIONS, so a recording kept across a restarted session
   *    (whose fresh counter starts at zero) must not grow past the schema's
   *    cap into something that cannot be saved at all.
   *
   * `start` resets the executed counter, so a stale one from a dead session
   * cannot block the restart the owner was just invited to make.
   */
  const atCap = Math.max(recorded.length, executedCount) >= MAX_DEMO_ACTIONS;

  const reset = () => {
    setDemoId(null);
    setTurn(null);
    setRecorded([]);
    setExecutedCount(0);
    setRemovedMidList(false);
    setGone(false);
    setPendingConfirm(null);
    setConfirmCancel(false);
    setFillDrafts({});
    setSuggestions(null);
    setAcceptedExpect(false);
    setError(null);
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setGone(false);
    setPendingConfirm(null);
    // A new session has performed nothing yet, so its budget is genuinely
    // fresh. Carrying a dead session's count forward would block the restart
    // the owner was just invited to make. The recording is deliberately KEPT
    // across a restart, and `atCap` still counts it.
    setExecutedCount(0);
    try {
      const res = await fetch("/api/aiflows/demo/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          url: url.trim(),
          ...(integrationLabel ? { integrationLabel } : {})
        })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { demoId: string } & TurnState;
        error?: { message: string };
      };
      if (json.ok && json.data) {
        setDemoId(json.data.demoId);
        setTurn({
          finalUrl: json.data.finalUrl,
          digest: json.data.digest,
          pageText: json.data.pageText ?? "",
          ...(json.data.screenshotBase64 ? { screenshotBase64: json.data.screenshotBase64 } : {}),
          ...(json.data.diagnostics ? { diagnostics: json.data.diagnostics } : {})
        });
      } else {
        setError(json.error?.message ?? "The demonstration could not be started.");
      }
    } catch {
      setError("The demonstration could not be started.");
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: DemoActRequestAction, confirm = false) => {
    if (!demoId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/aiflows/demo/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, demoId, action, ...(confirm ? { confirm: true } : {}) })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: ActData;
        error?: { message: string };
      };
      if (!json.ok || !json.data) {
        setError(json.error?.message ?? "That did not go through.");
        return;
      }
      const data = json.data;
      if (data.outcome === "recorded" && data.recorded) {
        const justRecorded = data.recorded;
        setPendingConfirm(null);
        setRecorded((prev) => [...prev, justRecorded]);
        setExecutedCount((prev) =>
          typeof data.actionsCount === "number" ? data.actionsCount : prev + 1
        );
        // Clear ONLY the box that was just sent. Teaching a form means
        // staging text in several boxes and submitting them in order, so
        // wiping the whole map would blank the ones still waiting, losing
        // text the page never touched.
        if (justRecorded.kind === "fill_selector" || justRecorded.kind === "fill_placeholder") {
          setFillDrafts((prev) => {
            const next = { ...prev };
            delete next[justRecorded.target];
            return next;
          });
        }
        // A new action makes any earlier suggestions stale (their indexes
        // and the final page both changed).
        setSuggestions(null);
        setTurn({
          finalUrl: data.finalUrl ?? "",
          digest: data.digest ?? { controls: [], links: [], headings: [] },
          pageText: data.pageText ?? "",
          ...(data.screenshotBase64 ? { screenshotBase64: data.screenshotBase64 } : {}),
          ...(data.diagnostics ? { diagnostics: data.diagnostics } : {})
        });
      } else if (data.outcome === "needs_confirm" && data.resolved) {
        // Resolved but NOT executed. Re-send the resolved action with
        // confirm: true once the owner says yes.
        setPendingConfirm({
          action: {
            kind: data.resolved.kind,
            target: data.resolved.target,
            ...(data.resolved.value !== undefined ? { value: data.resolved.value } : {})
          },
          label: data.label ?? data.resolved.target
        });
      } else if (data.outcome === "resolve_failed" && data.reason) {
        setError(describeDemoResolveFailure(data.reason, data.options));
      } else if (data.outcome === "action_failed") {
        setError(
          data.detail
            ? `That did not work on the page: ${data.detail}`
            : "That did not work on the page."
        );
        if (data.digest) {
          setTurn({
            finalUrl: data.finalUrl ?? "",
            digest: data.digest,
            pageText: data.pageText ?? "",
            ...(data.screenshotBase64 ? { screenshotBase64: data.screenshotBase64 } : {}),
            ...(data.diagnostics ? { diagnostics: data.diagnostics } : {})
          });
        }
      } else if (data.outcome === "demo_gone") {
        setGone(true);
        setDemoId(null);
        setPendingConfirm(null);
      } else if (data.outcome === "action_cap") {
        // The session is full even if the local list looks shorter (rows can
        // be removed, clicks cannot). Pin the local counter to the cap so the
        // controls disable instead of inviting another refused click.
        setExecutedCount(MAX_DEMO_ACTIONS);
        setError(DEMO_ACTION_CAP_MESSAGE);
      } else {
        setError("That did not go through.");
      }
    } catch {
      setError("That did not go through.");
    } finally {
      setBusy(false);
    }
  };

  /** A list-driven act: pre-confirm destructive labels without a round trip. */
  const actFromList = (action: DemoActRequestAction, label: string) => {
    if (isConfirmLabel(label)) {
      setPendingConfirm({ action, label });
      return;
    }
    void act(action);
  };

  const stopSession = async () => {
    if (!demoId) return;
    // Best-effort: an unreachable box changes nothing the owner can act on,
    // and the session expires on its own either way.
    try {
      await fetch("/api/aiflows/demo/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, demoId })
      });
    } catch {
      /* the idle sweep will reclaim it */
    }
  };

  const finish = async (mode: "replace" | "append") => {
    setBusy(true);
    await stopSession();
    setBusy(false);
    onFinish(toEditorActions(recorded), mode);
    reset();
    setNotice(
      "Saved into the step. Now run \"Try these actions\" against a fresh example page to prove the recording, and consider setting \"Proof it worked\" below."
    );
  };

  const cancel = async () => {
    setBusy(true);
    await stopSession();
    setBusy(false);
    reset();
  };

  const fetchSuggestions = async () => {
    setSuggestBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/aiflows/demo/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          actions: recorded,
          varsInScope,
          afterPageText: turn?.pageText ?? ""
        })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { suggestions: DemoSuggestions };
        error?: { message: string };
      };
      if (json.ok && json.data) {
        setSuggestions(json.data.suggestions);
        setAcceptedExpect(false);
        if (json.data.suggestions.fills.length === 0 && !json.data.suggestions.expectText) {
          setNotice("Nothing to suggest: the recording already looks general enough.");
        }
      } else {
        setError(json.error?.message ?? "Suggestions could not be generated this time.");
      }
    } catch {
      setError("Suggestions could not be generated this time.");
    } finally {
      setSuggestBusy(false);
    }
  };

  const acceptFill = (index: number, placeholder: string) => {
    setRecorded((prev) => prev.map((a, i) => (i === index ? { ...a, value: placeholder } : a)));
    setSuggestions((prev) =>
      prev ? { ...prev, fills: prev.fills.filter((f) => f.index !== index) } : prev
    );
  };

  const clickPoint = (e: React.MouseEvent<HTMLImageElement>) => {
    if (busy || !live || atCap) return;
    const img = imgRef.current;
    if (!img || img.naturalWidth === 0 || img.clientWidth === 0) return;
    // Screenshot pixels ARE document CSS pixels (captured at scale 1 from the
    // document origin), so the only translation needed is the render scale.
    const rect = img.getBoundingClientRect();
    const scale = img.naturalWidth / rect.width;
    const x = Math.round((e.clientX - rect.left) * scale);
    const y = Math.round((e.clientY - rect.top) * scale);
    void act({ kind: "click_point", x, y });
  };

  const appendWouldOverflow = existingActionsCount + recorded.length > MAX_DEMO_ACTIONS;
  const diagnosticLines = describePageDiagnostics(turn?.diagnostics);

  return (
    <div className="rounded-lg border border-parchment/10 bg-deep-ink/40 p-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-semibold text-signal-teal hover:underline"
        aria-expanded={open}
      >
        <GraduationCap className="h-3.5 w-3.5" />
        {open ? "Hide the demonstration" : "Teach it by doing it once"}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] leading-snug text-spark-orange/90">{DEMO_LIVE_WARNING}</p>
          <p className="text-[11px] leading-snug text-parchment/50">
            Do the task once, here, and each thing you do becomes a step action. Best done on a
            record you do not mind updating for real (the update really happens). Up to{" "}
            {MAX_DEMO_ACTIONS} actions fit in one step.
          </p>

          {!live && !gone && (
            <>
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  value={url}
                  placeholder="https://..."
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && url.trim() && !busy) void start();
                  }}
                />
                <button
                  onClick={() => void start()}
                  disabled={busy || url.trim().length === 0}
                  className="shrink-0 rounded-md bg-signal-teal/90 px-2 py-1 text-xs font-semibold text-deep-ink disabled:opacity-40"
                >
                  {busy ? "Opening and signing in..." : "Start"}
                </button>
              </div>
              {busy && (
                <p className="text-[11px] text-parchment/40">
                  Opening the page in your business&apos;s browser (a fresh sign-in can take a
                  minute or two).
                </p>
              )}
              {integrationLabel ? (
                <p className="text-[11px] text-parchment/40">
                  Signing in with your saved &quot;{integrationLabel}&quot; login.
                </p>
              ) : (
                <p className="text-[11px] text-parchment/40">
                  No login set on this step, so the page opens as a signed-out visitor.
                </p>
              )}
            </>
          )}

          {notice && <p className="text-[11px] leading-snug text-claw-green">{notice}</p>}
          {error && <p className="text-[11px] leading-snug text-spark-orange">{error}</p>}

          {gone && (
            <div className="space-y-2 rounded-md border border-spark-orange/30 bg-deep-ink/60 p-2">
              <p className="text-[11px] leading-snug text-parchment/70">{DEMO_GONE_MESSAGE}</p>
              <button
                onClick={() => void start()}
                disabled={busy || url.trim().length === 0}
                className="rounded-md bg-signal-teal/90 px-2 py-1 text-xs font-semibold text-deep-ink disabled:opacity-40"
              >
                Start again on the same address
              </button>
            </div>
          )}

          {live && turn && (
            <div className="space-y-3 border-t border-parchment/10 pt-2">
              <div className="flex items-center gap-2 rounded-md border border-spark-orange/40 bg-spark-orange/10 px-2 py-1">
                <CircleDot className="h-3 w-3 shrink-0 animate-pulse text-spark-orange" />
                <p className="text-[11px] font-semibold text-spark-orange">
                  LIVE session on {hostnameOf(turn.finalUrl) || "the page"}. Clicks are real.
                </p>
              </div>

              {pendingConfirm && (
                <div className="space-y-1 rounded-md border border-spark-orange/40 bg-deep-ink/60 p-2">
                  <p className="text-[11px] leading-snug text-parchment/80">
                    &quot;{pendingConfirm.label}&quot; looks like it commits something (a claim, a
                    submit, a send). It will really happen on the site. Do it and record it?
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        const pending = pendingConfirm;
                        setPendingConfirm(null);
                        if (pending) void act(pending.action, true);
                      }}
                      disabled={busy}
                      className="rounded-md bg-spark-orange/90 px-2 py-1 text-xs font-semibold text-deep-ink disabled:opacity-40"
                    >
                      Yes, do it for real
                    </button>
                    <button
                      onClick={() => setPendingConfirm(null)}
                      disabled={busy}
                      className="rounded-md border border-parchment/20 px-2 py-1 text-xs text-parchment/70 disabled:opacity-40"
                    >
                      No, skip it
                    </button>
                  </div>
                </div>
              )}

              {turn.screenshotBase64 && (
                <div className="space-y-1">
                  <p className="text-[11px] text-parchment/50">
                    Click anywhere on the picture to click that spot on the real page.
                  </p>
                  <div className="max-h-96 overflow-y-auto rounded-md border border-parchment/10">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a
                        data: URI from the tenant's own box; next/image would
                        try to optimize it through the loader. */}
                    <img
                      ref={imgRef}
                      src={`data:image/jpeg;base64,${turn.screenshotBase64}`}
                      alt="The live page. Click a control on it to perform and record that click."
                      onClick={clickPoint}
                      className={`h-auto w-full ${busy || atCap ? "cursor-wait opacity-60" : "cursor-crosshair"}`}
                    />
                  </div>
                </div>
              )}
              {busy && <p className="text-[11px] text-parchment/40">Doing it on the page...</p>}

              {turn.digest.headings.length > 0 && (
                <p className="text-[11px] text-parchment/50">
                  This page says: {turn.digest.headings.slice(0, 4).join(" · ")}
                </p>
              )}

              {/* The same control groups the picker shows, except here a
                  click PERFORMS the action on the live page and records it. */}
              {PAGE_CONTROL_GROUPS.map((group) => {
                const rows = turn.digest.controls.filter((c) => c.group === group);
                if (rows.length === 0) return null;
                return (
                  <div key={group} className="space-y-1">
                    <p className="text-[11px] font-semibold text-parchment/70">{group}</p>
                    {rows.map((control) => (
                      <div key={`${control.kind}:${control.target}`} className="space-y-1">
                        {control.kind === "fill_selector" || control.kind === "fill_placeholder" ? (
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 shrink break-words font-mono text-[11px] text-parchment/70">
                              {control.label}
                            </span>
                            <input
                              className={inputClass}
                              value={fillDrafts[control.target] ?? ""}
                              placeholder="Type what goes in it..."
                              disabled={busy || atCap}
                              onChange={(e) =>
                                setFillDrafts((prev) => ({
                                  ...prev,
                                  [control.target]: e.target.value
                                }))
                              }
                            />
                            <button
                              onClick={() =>
                                actFromList(
                                  {
                                    kind: control.kind,
                                    target: control.target,
                                    value: fillDrafts[control.target] ?? ""
                                  },
                                  control.label
                                )
                              }
                              disabled={busy || atCap}
                              className="shrink-0 rounded-md border border-parchment/20 px-2 py-1 text-[11px] text-parchment/70 hover:border-signal-teal disabled:opacity-40"
                            >
                              Type it
                            </button>
                          </div>
                        ) : control.kind === "select_option" ? (
                          <div className="space-y-1">
                            <span className="break-words font-mono text-[11px] text-parchment/70">
                              {control.label}
                            </span>
                            {control.options && control.options.length > 0 && (
                              <div className="flex flex-wrap gap-1 pl-2">
                                {control.options.map((option) => (
                                  <button
                                    key={option}
                                    onClick={() =>
                                      actFromList(
                                        {
                                          kind: "select_option",
                                          target: control.target,
                                          value: option
                                        },
                                        option
                                      )
                                    }
                                    disabled={busy || atCap}
                                    className="rounded-full border border-parchment/15 px-2 py-0.5 text-[10px] text-parchment/60 hover:border-signal-teal hover:text-parchment disabled:opacity-40"
                                  >
                                    choose &quot;{option}&quot;
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-start gap-2">
                            <button
                              onClick={() =>
                                actFromList(
                                  { kind: control.kind, target: control.target },
                                  control.label
                                )
                              }
                              disabled={busy || atCap}
                              className="mt-0.5 shrink-0 text-signal-teal hover:text-parchment disabled:opacity-40"
                              aria-label={`Do and record: ${control.label}`}
                            >
                              <Plus className="h-3 w-3" />
                            </button>
                            <span className="min-w-0 break-words font-mono text-[11px] text-parchment/70">
                              {control.label}
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}

              {diagnosticLines.length > 0 && (
                <div className="space-y-1 rounded-md border border-parchment/10 bg-deep-ink/40 p-2">
                  <p className="text-[11px] font-semibold text-parchment/70">
                    What the page reported about itself
                  </p>
                  {diagnosticLines.map((line, i) => (
                    <p key={i} className="break-all font-mono text-[10px] text-parchment/50">
                      {line}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {(recorded.length > 0 || live || gone) && (
            <div className="space-y-2 border-t border-parchment/10 pt-2">
              <p className="text-[11px] font-semibold text-parchment/70">
                Recorded so far: {recorded.length} of {MAX_DEMO_ACTIONS}
              </p>
              {executedCount > recorded.length && (
                <p className="text-[11px] leading-snug text-parchment/40">
                  This session has done {executedCount} thing{executedCount === 1 ? "" : "s"} on the
                  site. That is what the limit counts, since a removed row was still really done.
                </p>
              )}
              {recorded.length === 0 && (
                <p className="text-[11px] text-parchment/40">
                  Nothing yet. Everything you do on the page above lands here.
                </p>
              )}
              {recorded.map((a, i) => (
                <div key={`${a.kind}:${a.target}:${i}`} className="flex items-start gap-2">
                  <button
                    onClick={() => {
                      if (i < recorded.length - 1) setRemovedMidList(true);
                      setRecorded((prev) => prev.filter((_, xi) => xi !== i));
                      // Suggestions point at indexes, which just shifted.
                      setSuggestions(null);
                    }}
                    disabled={busy}
                    className="mt-0.5 shrink-0 text-parchment/40 hover:text-spark-orange disabled:opacity-40"
                    aria-label={`Remove recorded action ${i + 1}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                  <span className="min-w-0 break-words font-mono text-[11px] text-parchment/70">
                    {i + 1}. {a.kind} {a.target}
                    {a.value ? ` = "${a.value}"` : ""}
                  </span>
                </div>
              ))}
              {recorded.length > 0 && (
                <>
                  <button
                    onClick={() => {
                      setRecorded((prev) => prev.slice(0, -1));
                      setSuggestions(null);
                    }}
                    disabled={busy}
                    className="flex items-center gap-1 text-[11px] text-parchment/50 hover:text-parchment disabled:opacity-40"
                  >
                    <Undo2 className="h-3 w-3" /> Undo the last one
                  </button>
                  <p className="flex items-start gap-1 text-[11px] leading-snug text-parchment/40">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-spark-orange/70" />
                    {DEMO_REMOVE_WARNING}
                  </p>
                  {removedMidList && (
                    <p className="text-[11px] leading-snug text-spark-orange/80">
                      You removed a step from the middle, so the later steps may assume a page
                      state that removal does not restore. It is usually safer to start the
                      demonstration over.
                    </p>
                  )}
                </>
              )}

              {recorded.length > 0 && (
                <div className="space-y-1 pt-1">
                  <button
                    onClick={() => void fetchSuggestions()}
                    disabled={busy || suggestBusy}
                    className="flex items-center gap-1 text-[11px] text-signal-teal hover:underline disabled:opacity-40"
                  >
                    <Sparkles className="h-3 w-3" />
                    {suggestBusy
                      ? "Looking at the recording..."
                      : "Suggest improvements (map typed values to variables, propose a proof)"}
                  </button>
                  {suggestions && suggestions.fills.length > 0 && (
                    <div className="space-y-1">
                      {suggestions.fills.map((fill) => {
                        const action = recorded[fill.index];
                        if (!action) return null;
                        return (
                          <div
                            key={`${fill.index}:${fill.placeholder}`}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <span className="min-w-0 break-words text-[11px] text-parchment/60">
                              Step {fill.index + 1}: use{" "}
                              <span className="font-mono">{fill.placeholder}</span> instead of
                              &quot;{action.value}&quot; so it works for every record
                            </span>
                            <button
                              onClick={() => acceptFill(fill.index, fill.placeholder)}
                              disabled={busy}
                              className="rounded-full border border-parchment/15 px-2 py-0.5 text-[10px] text-signal-teal hover:border-signal-teal disabled:opacity-40"
                            >
                              use it
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {suggestions?.expectText && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 break-words text-[11px] text-parchment/60">
                        Set &quot;Proof it worked&quot; to &quot;{suggestions.expectText}&quot; (the
                        page showed it after your last step)
                      </span>
                      <button
                        onClick={() => {
                          onSetExpectText(suggestions.expectText ?? "");
                          setAcceptedExpect(true);
                        }}
                        disabled={busy || acceptedExpect}
                        className="rounded-full border border-parchment/15 px-2 py-0.5 text-[10px] text-signal-teal hover:border-signal-teal disabled:opacity-40"
                      >
                        {acceptedExpect ? "set" : "set it"}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {recorded.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    onClick={() => void finish("replace")}
                    disabled={busy}
                    className="rounded-md bg-signal-teal/90 px-2 py-1 text-xs font-semibold text-deep-ink disabled:opacity-40"
                  >
                    Save these {recorded.length} action{recorded.length === 1 ? "" : "s"} to the
                    step
                  </button>
                  {existingActionsCount > 0 && (
                    <button
                      onClick={() => void finish("append")}
                      disabled={busy || appendWouldOverflow}
                      title={
                        appendWouldOverflow
                          ? `The step already has ${existingActionsCount}, and a step holds at most ${MAX_DEMO_ACTIONS}.`
                          : undefined
                      }
                      className="rounded-md border border-parchment/20 px-2 py-1 text-xs text-parchment/70 hover:border-signal-teal disabled:opacity-40"
                    >
                      Add to the end of the existing {existingActionsCount} instead
                    </button>
                  )}
                </div>
              )}
              {existingActionsCount > 0 && recorded.length > 0 && (
                <p className="text-[11px] text-parchment/40">
                  Saving replaces the step&apos;s current {existingActionsCount} action
                  {existingActionsCount === 1 ? "" : "s"}; a demonstration usually captures the
                  whole task from the starting page.
                </p>
              )}

              {(live || gone) && (
                <div className="pt-1">
                  {confirmCancel ? (
                    <div className="space-y-1">
                      <p className="text-[11px] leading-snug text-parchment/60">
                        Discard the recording? The site keeps whatever you already did there.
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => void cancel()}
                          disabled={busy}
                          className="rounded-md border border-spark-orange/40 px-2 py-1 text-xs text-spark-orange disabled:opacity-40"
                        >
                          Discard it
                        </button>
                        <button
                          onClick={() => setConfirmCancel(false)}
                          disabled={busy}
                          className="rounded-md border border-parchment/20 px-2 py-1 text-xs text-parchment/70 disabled:opacity-40"
                        >
                          Keep going
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmCancel(true)}
                      disabled={busy}
                      className="text-[11px] text-parchment/40 hover:text-spark-orange disabled:opacity-40"
                    >
                      Cancel and discard the recording
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
