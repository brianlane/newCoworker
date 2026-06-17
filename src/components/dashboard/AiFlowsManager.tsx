"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Plus, Trash2, ArrowUp, ArrowDown, Sparkles, Pencil, Copy } from "lucide-react";
import {
  BROWSE_ACTION_KINDS,
  ENGINE_PROVIDED_VARS,
  FLOW_STEP_TYPES,
  TRIGGER_CONDITION_TYPES,
  HTTP_METHODS,
  summarizeDefinition,
  type AiFlowDefinition,
  type FlowStep,
  type FlowTrigger,
  type StepCondition,
  type TriggerCondition
} from "@/lib/ai-flows/schema";
import type { AiFlowRow } from "@/lib/ai-flows/db";
import {
  STEP_TYPE_LABELS,
  STEP_TYPE_HELP,
  CONDITION_LABELS,
  BROWSE_ACTION_LABELS
} from "@/components/dashboard/aiflow-labels";
import { getAiFlowExampleCopy, type AiFlowExampleCopy } from "@/lib/ai-flows/examples";

// Mirrors EMAIL_PROVIDER_CONFIG_KEYS in src/lib/voice-tools/connections.ts —
// that module is server-only (it pulls in the service-role Supabase client),
// so the client bundle keeps its own copy of these three string keys.
const EMAIL_CONNECTION_KEYS = ["google-mail", "gmail", "outlook"];

/** A connected owner mailbox the editor can offer as an email "From". */
export type EmailConnectionOption = { id: string; label: string };

/** A team member with an email, offered in the cc/bcc "Add employee" picker. */
export type EmployeeEmailOption = { name: string; email: string };

const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none";
const labelClass = "block text-xs font-medium text-parchment/60 mb-1";

/** How the workflow starts. Mirrors TRIGGER_CHANNELS in the schema. */
const CHANNEL_LABELS: Record<FlowTrigger["channel"], string> = {
  sms: "Inbound text (SMS)",
  manual: "Manual — Run now button",
  schedule: "On a schedule",
  email: "Inbound email (your connected inbox)",
  tenant_email: "Inbound email (AI coworker's mailbox)"
};

type EditorState = {
  id: string | null;
  name: string;
  enabled: boolean;
  suppressDefaultReply: boolean;
  channel: FlowTrigger["channel"];
  correlationWindowMinutes: number;
  conditions: TriggerCondition[];
  scheduleMode: "daily" | "every";
  scheduleTime: string;
  scheduleTimezone: string;
  scheduleDays: number[];
  scheduleEvery: number;
  emailConnectionId: string;
  steps: FlowStep[];
};

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Phoenix";
  } catch {
    return "America/Phoenix";
  }
}

function emptyEditor(): EditorState {
  return {
    id: null,
    name: "",
    enabled: true,
    suppressDefaultReply: false,
    channel: "sms",
    correlationWindowMinutes: 10,
    conditions: [{ type: "has_url" }],
    scheduleMode: "daily",
    scheduleTime: "08:30",
    scheduleTimezone: browserTimezone(),
    scheduleDays: [],
    scheduleEvery: 60,
    emailConnectionId: "",
    steps: []
  };
}

/** Trigger-derived editor fields (shared by editorFromRow + the AI generator). */
function triggerToEditorFields(trigger: FlowTrigger): Pick<
  EditorState,
  | "channel"
  | "correlationWindowMinutes"
  | "conditions"
  | "scheduleMode"
  | "scheduleTime"
  | "scheduleTimezone"
  | "scheduleDays"
  | "scheduleEvery"
  | "emailConnectionId"
> {
  const base = {
    channel: trigger.channel,
    correlationWindowMinutes: 10,
    conditions: [] as TriggerCondition[],
    scheduleMode: "daily" as const,
    scheduleTime: "08:30",
    scheduleTimezone: browserTimezone(),
    scheduleDays: [] as number[],
    scheduleEvery: 60,
    emailConnectionId: ""
  };
  switch (trigger.channel) {
    case "sms":
      return {
        ...base,
        correlationWindowMinutes: trigger.correlationWindowMinutes ?? 10,
        conditions: trigger.conditions
      };
    case "manual":
      return base;
    case "schedule":
      if (trigger.everyMinutes !== undefined) {
        return { ...base, scheduleMode: "every", scheduleEvery: trigger.everyMinutes };
      }
      return {
        ...base,
        scheduleTime: trigger.time ?? "08:30",
        scheduleTimezone: trigger.timezone ?? browserTimezone(),
        scheduleDays: trigger.daysOfWeek ?? []
      };
    case "email":
      return {
        ...base,
        conditions: trigger.conditions,
        emailConnectionId: trigger.connectionId
      };
    case "tenant_email":
      return { ...base, conditions: trigger.conditions };
  }
}

function editorFromRow(row: AiFlowRow): EditorState {
  const def = row.definition;
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    suppressDefaultReply: def.options?.suppressDefaultReply ?? false,
    ...triggerToEditorFields(def.trigger),
    steps: def.steps
  };
}

function freshStepId(): string {
  return `s_${(crypto.randomUUID?.() ?? String(Date.now())).slice(0, 8)}`;
}

function newStep(type: FlowStep["type"], examples: AiFlowExampleCopy): FlowStep {
  const id = freshStepId();
  switch (type) {
    case "extract_url":
      return { id, type, saveAs: "lead_url" };
    case "browse_extract":
      return { id, type, urlVar: "lead_url", fields: [{ name: examples.contactVar, description: "" }] };
    case "extract_text":
      return { id, type, fields: [{ name: examples.contactVar, description: "" }] };
    case "send_sms":
      return { id, type, to: `{{vars.${examples.contactVar}}}`, body: "" };
    case "send_email":
      return { id, type, to: "", subject: "", body: "" };
    case "approval_gate":
      return { id, type, prompt: "Send this message?" };
    case "notify_owner":
      return { id, type, message: "" };
    case "http_call":
      return { id, type, label: "", method: "POST", path: "", bodyTemplate: "", saveAs: "" };
    case "route_to_team":
      return {
        id,
        type,
        offerTemplate:
          "New lead {{vars.lead_name}} ({{vars.lead_phone}}) in {{vars.location}}. " +
          "Reply 1 to claim or 2 to pass by {{offer.deadline}}.",
        responseMinutes: 10,
        ownerFallbackTemplate:
          "No agent claimed {{vars.lead_name}} ({{vars.lead_phone}}). It's back to you."
        // claimedNotifyTemplate is optional and omitted by default — an empty
        // string would fail the schema's min(1)-when-present rule on save.
      };
    case "browse_action":
      return {
        id,
        type,
        urlVar: "lead_url",
        actions: [{ kind: "click_text", target: "" }]
      };
  }
}

/** Vars a single step produces (visible to LATER steps). Mirrors schema scope. */
function varsProducedByStep(step: FlowStep): string[] {
  if (step.type === "extract_url") return [step.saveAs];
  if (step.type === "browse_extract") return step.fields.map((f) => f.name).filter(Boolean);
  if (step.type === "extract_text") return step.fields.map((f) => f.name).filter(Boolean);
  if (step.type === "http_call" && step.saveAs) return [step.saveAs];
  return [];
}

/** Deep-clone a step with a fresh id, for the per-step duplicate button. */
function duplicateOf(step: FlowStep): FlowStep {
  return { ...(JSON.parse(JSON.stringify(step)) as FlowStep), id: freshStepId() };
}

/** All vars produced by steps BEFORE `index` — the legal targets for a `when`. */
function varsProducedBefore(steps: FlowStep[], index: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < index; i++) {
    for (const v of varsProducedByStep(steps[i])) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}

function editorTrigger(s: EditorState): FlowTrigger {
  switch (s.channel) {
    case "sms":
      return {
        channel: "sms",
        correlationWindowMinutes: s.correlationWindowMinutes,
        conditions: s.conditions
      };
    case "manual":
      return { channel: "manual" };
    case "schedule":
      return s.scheduleMode === "every"
        ? { channel: "schedule", everyMinutes: s.scheduleEvery }
        : {
            channel: "schedule",
            time: s.scheduleTime,
            timezone: s.scheduleTimezone,
            ...(s.scheduleDays.length > 0 ? { daysOfWeek: [...s.scheduleDays].sort() } : {})
          };
    case "email":
      return { channel: "email", connectionId: s.emailConnectionId, conditions: s.conditions };
    case "tenant_email":
      return { channel: "tenant_email", conditions: s.conditions };
  }
}

function toDefinition(s: EditorState): AiFlowDefinition {
  return {
    version: 1,
    trigger: editorTrigger(s),
    steps: s.steps,
    options: { suppressDefaultReply: s.suppressDefaultReply }
  };
}

export function AiFlowsManager({
  businessId,
  businessType,
  initialFlows
}: {
  businessId: string;
  businessType?: string | null;
  initialFlows: AiFlowRow[];
}) {
  const examples = getAiFlowExampleCopy(businessType);
  const [flows, setFlows] = useState<AiFlowRow[]>(initialFlows);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [emailConns, setEmailConns] = useState<EmailConnectionOption[]>([]);
  const [employees, setEmployees] = useState<EmployeeEmailOption[]>([]);
  // Run-now panel: which flow's panel is open, its input, and the last outcome.
  const [runFor, setRunFor] = useState<string | null>(null);
  const [runInput, setRunInput] = useState("");
  const [runNotice, setRunNotice] = useState<string | null>(null);

  // Connected owner mailboxes for the send_email "From" dropdown (and the
  // quiet-hours email fallback). Best-effort: on any failure the dropdown
  // simply offers only the AI coworker's own mailbox.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/integrations/workspace?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as {
          ok: boolean;
          data?: Array<{
            id: string;
            providerConfigKey: string;
            connectionId: string;
            metadata?: Record<string, unknown>;
          }>;
        };
        if (cancelled || !json.ok || !json.data) return;
        setEmailConns(
          json.data
            .filter((c) => EMAIL_CONNECTION_KEYS.includes(c.providerConfigKey))
            .map((c) => {
              const email = typeof c.metadata?.email === "string" ? c.metadata.email : "";
              return {
                id: c.id,
                label: email ? `${c.providerConfigKey} — ${email}` : c.providerConfigKey
              };
            })
        );
      } catch {
        /* options stay empty; the dropdown still offers the AI coworker mailbox */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  // Team roster (ai_flow_team_members) for the cc/bcc "Add employee" picker.
  // Best-effort: on any failure the picker simply hides and owners type emails.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/dashboard/employees?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as {
          ok: boolean;
          data?: { members?: Array<{ name?: string; email?: string | null }> };
        };
        if (cancelled || !json.ok || !json.data?.members) return;
        setEmployees(
          json.data.members
            .filter((m): m is { name?: string; email: string } =>
              typeof m.email === "string" && m.email.length > 0
            )
            .map((m) => ({ name: typeof m.name === "string" ? m.name : m.email, email: m.email }))
        );
      } catch {
        /* picker stays empty; owners can still type cc/bcc addresses */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const patchStep = (index: number, patch: Record<string, unknown>) => {
    setEditor((e) =>
      e
        ? { ...e, steps: e.steps.map((st, i) => (i === index ? ({ ...st, ...patch } as FlowStep) : st)) }
        : e
    );
  };

  const moveStep = (index: number, dir: -1 | 1) => {
    setEditor((e) => {
      if (!e) return e;
      const j = index + dir;
      if (j < 0 || j >= e.steps.length) return e;
      const steps = [...e.steps];
      [steps[index], steps[j]] = [steps[j], steps[index]];
      return { ...e, steps };
    });
  };

  const reload = async () => {
    const res = await fetch(`/api/aiflows?businessId=${encodeURIComponent(businessId)}`, {
      cache: "no-store"
    });
    const json = (await res.json()) as { ok: boolean; data?: AiFlowRow[] };
    if (json.ok && json.data) setFlows(json.data);
  };

  const save = async () => {
    if (!editor) return;
    setBusy(true);
    setError(null);
    try {
      const definition = toDefinition(editor);
      const payload = { businessId, name: editor.name, enabled: editor.enabled, definition };
      const res = editor.id
        ? await fetch(`/api/aiflows/${editor.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          })
        : await fetch(`/api/aiflows`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Save failed");
        return;
      }
      setEditor(null);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await fetch(`/api/aiflows/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  /** Create a disabled copy of an existing flow ("Name (copy)"). */
  const duplicateFlow = async (row: AiFlowRow) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/aiflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          name: `${row.name} (copy)`.slice(0, 120),
          enabled: false,
          definition: row.definition
        })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Duplicate failed");
        return;
      }
      await reload();
    } finally {
      setBusy(false);
    }
  };

  /** Start one manual run (any trigger channel; the flow must be enabled). */
  const runNow = async (row: AiFlowRow) => {
    setBusy(true);
    setRunNotice(null);
    try {
      const res = await fetch(`/api/aiflows/${row.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, input: runInput.trim() || undefined })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) {
        setRunNotice(json.error?.message ?? "Run failed to start");
        return;
      }
      setRunNotice("Run queued — see View runs for progress.");
      setRunInput("");
      setRunFor(null);
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (row: AiFlowRow) => {
    await fetch(`/api/aiflows/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId, enabled: !row.enabled })
    });
    await reload();
  };

  const generateWithAi = async () => {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/aiflows/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, description: aiPrompt })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { definition: AiFlowDefinition };
        error?: { message: string };
      };
      if (!json.ok || !json.data) {
        setError(json.error?.message ?? "AI generation failed");
        return;
      }
      const def = json.data.definition;
      setEditor((e) => ({
        id: e?.id ?? null,
        name: e?.name || "New automation",
        enabled: e?.enabled ?? true,
        suppressDefaultReply: def.options?.suppressDefaultReply ?? false,
        ...triggerToEditorFields(def.trigger),
        steps: def.steps
      }));
    } finally {
      setAiBusy(false);
    }
  };

  if (editor) {
    return (
      <Card className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-parchment">
            {editor.id ? "Edit AiFlow" : "New AiFlow"}
          </h2>
          <button
            onClick={() => setEditor(null)}
            className="text-sm text-parchment/50 hover:text-parchment"
          >
            Cancel
          </button>
        </div>

        {error && (
          <p className="rounded-md border border-spark-orange/40 bg-spark-orange/5 px-3 py-2 text-sm text-spark-orange">
            {error}
          </p>
        )}

        <div>
          <label className={labelClass}>Name</label>
          <input
            className={inputClass}
            value={editor.name}
            onChange={(ev) => setEditor({ ...editor, name: ev.target.value })}
            placeholder={examples.namePlaceholder}
          />
        </div>

        {editor.id === null && (
          <div className="rounded-md border border-parchment/10 bg-deep-ink/20 p-4 space-y-3">
            <div className="flex items-center gap-2 text-parchment/70">
              <Sparkles className="h-4 w-4 text-signal-teal" />
              <span className="text-sm font-medium">Generate with AI</span>
            </div>
            <p className="text-[11px] text-parchment/40">
              Describe what you want in plain English and we’ll draft the steps for you. You can
              edit everything afterward.
            </p>
            <textarea
              className={inputClass}
              rows={2}
              value={aiPrompt}
              onChange={(ev) => setAiPrompt(ev.target.value)}
              placeholder={examples.aiPromptPlaceholder}
            />
            <button
              onClick={generateWithAi}
              disabled={aiBusy}
              className="rounded-md bg-signal-teal/20 px-3 py-1.5 text-sm text-signal-teal hover:bg-signal-teal/30 disabled:opacity-50"
            >
              {aiBusy ? "Generating…" : "Generate steps"}
            </button>
          </div>
        )}

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-parchment/40">Trigger</h3>
          <p className="text-[11px] text-parchment/40">
            The trigger is what kicks off this workflow — pick how it should start below.
          </p>
          <div>
            <label className={labelClass}>Starts when</label>
            <select
              className={inputClass}
              value={editor.channel}
              onChange={(ev) =>
                setEditor({ ...editor, channel: ev.target.value as FlowTrigger["channel"] })
              }
            >
              {(Object.keys(CHANNEL_LABELS) as FlowTrigger["channel"][]).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          {editor.channel === "manual" && (
            <p className="text-xs text-parchment/50">
              This workflow only starts from the Run now button on the AiFlows list (you can
              pass it a link or text when starting it).
            </p>
          )}
          {editor.channel === "schedule" && (
            <div className="space-y-2">
              <select
                className={inputClass}
                value={editor.scheduleMode}
                onChange={(ev) =>
                  setEditor({ ...editor, scheduleMode: ev.target.value as "daily" | "every" })
                }
              >
                <option value="daily">Daily at a time</option>
                <option value="every">Every N minutes</option>
              </select>
              {editor.scheduleMode === "daily" ? (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelClass}>Time (24h HH:MM)</label>
                    <input
                      className={inputClass}
                      value={editor.scheduleTime}
                      onChange={(ev) => setEditor({ ...editor, scheduleTime: ev.target.value })}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Time zone</label>
                    <input
                      className={inputClass}
                      value={editor.scheduleTimezone}
                      onChange={(ev) => setEditor({ ...editor, scheduleTimezone: ev.target.value })}
                    />
                  </div>
                  <div className="col-span-2">
                    <label className={labelClass}>Days (default: every day)</label>
                    <div className="flex flex-wrap gap-2">
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, di) => (
                        <label key={d} className="flex items-center gap-1 text-xs text-parchment/70">
                          <input
                            type="checkbox"
                            checked={editor.scheduleDays.includes(di)}
                            onChange={(ev) =>
                              setEditor({
                                ...editor,
                                scheduleDays: ev.target.checked
                                  ? [...editor.scheduleDays, di]
                                  : editor.scheduleDays.filter((x) => x !== di)
                              })
                            }
                          />
                          {d}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <label className={labelClass}>Every N minutes (min 15)</label>
                  <input
                    type="number"
                    className={inputClass}
                    value={editor.scheduleEvery}
                    onChange={(ev) =>
                      setEditor({ ...editor, scheduleEvery: Number(ev.target.value) || 60 })
                    }
                  />
                </div>
              )}
            </div>
          )}
          {editor.channel === "email" && (
            <div>
              <label className={labelClass}>Watch mailbox</label>
              <select
                className={inputClass}
                value={editor.emailConnectionId}
                onChange={(ev) => setEditor({ ...editor, emailConnectionId: ev.target.value })}
              >
                <option value="">Select a connected mailbox…</option>
                {emailConns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
                {editor.emailConnectionId &&
                  !emailConns.some((c) => c.id === editor.emailConnectionId) && (
                    <option value={editor.emailConnectionId}>
                      connected mailbox (disconnected?)
                    </option>
                  )}
              </select>
              <p className="mt-1 text-[11px] text-parchment/40">
                Connect another mailbox under Settings → Integrations to see it here.
              </p>
            </div>
          )}
          {editor.channel === "tenant_email" && (
            <div className="rounded-md border border-parchment/10 bg-deep-ink/20 p-3">
              <p className="text-[11px] text-parchment/60">
                This runs when your AI coworker&apos;s own email address receives a message. The
                address is shown (and can be personalized on Standard and above) under Settings →
                Mailbox. No mailbox connection is needed.
              </p>
            </div>
          )}
          {editor.channel === "sms" && (
            <div>
              <label className={labelClass}>Combine related texts that arrive within (minutes)</label>
              <input
                type="number"
                className={inputClass}
                value={editor.correlationWindowMinutes}
                onChange={(ev) =>
                  setEditor({ ...editor, correlationWindowMinutes: Number(ev.target.value) || 0 })
                }
              />
              <p className="mt-1 text-[11px] text-parchment/40">
                If a lead sends several texts in a row, wait this long to group them together
                before starting the workflow.
              </p>
            </div>
          )}
          {(editor.channel === "sms" ||
            editor.channel === "email" ||
            editor.channel === "tenant_email") &&
            editor.conditions.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                className={inputClass}
                value={c.type}
                onChange={(ev) => {
                  const type = ev.target.value as TriggerCondition["type"];
                  const next: TriggerCondition =
                    type === "has_url" ? { type } : { type, value: "value" in c ? c.value : "" };
                  setEditor({
                    ...editor,
                    conditions: editor.conditions.map((x, xi) => (xi === i ? next : x))
                  });
                }}
              >
                {TRIGGER_CONDITION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CONDITION_LABELS[t]}
                  </option>
                ))}
              </select>
              {c.type !== "has_url" && (
                <input
                  className={inputClass}
                  value={c.value}
                  onChange={(ev) =>
                    setEditor({
                      ...editor,
                      conditions: editor.conditions.map((x, xi) =>
                        xi === i ? ({ ...x, value: ev.target.value } as TriggerCondition) : x
                      )
                    })
                  }
                  placeholder="text / pattern / sender"
                />
              )}
              <button
                onClick={() =>
                  setEditor({
                    ...editor,
                    conditions: editor.conditions.filter((_, xi) => xi !== i)
                  })
                }
                className="text-parchment/40 hover:text-spark-orange"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          {(editor.channel === "sms" ||
            editor.channel === "email" ||
            editor.channel === "tenant_email") && (
            <button
              onClick={() =>
                setEditor({ ...editor, conditions: [...editor.conditions, { type: "contains", value: "" }] })
              }
              className="inline-flex items-center gap-1 text-sm text-signal-teal hover:underline"
            >
              <Plus className="h-3 w-3" /> Add condition
            </button>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-parchment/40">Steps</h3>
          <p className="text-[11px] text-parchment/40">
            Steps run top to bottom. Tip: type something like {`{{vars.${examples.tipVar}}}`} to reuse a
            detail an earlier step found, or {"{{trigger.url}}"} for the link from the text that
            started the workflow.
          </p>
          {editor.steps.map((step, i) => (
            <div key={step.id} className="rounded-md border border-parchment/10 bg-deep-ink/20 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-parchment">
                  {i + 1}. {STEP_TYPE_LABELS[step.type]}
                </span>
                <div className="flex items-center gap-2 text-parchment/40">
                  <button onClick={() => moveStep(i, -1)} aria-label="Move up">
                    <ArrowUp className="h-4 w-4 hover:text-parchment" />
                  </button>
                  <button onClick={() => moveStep(i, 1)} aria-label="Move down">
                    <ArrowDown className="h-4 w-4 hover:text-parchment" />
                  </button>
                  <button
                    onClick={() =>
                      setEditor({
                        ...editor,
                        steps: [
                          ...editor.steps.slice(0, i + 1),
                          duplicateOf(step),
                          ...editor.steps.slice(i + 1)
                        ]
                      })
                    }
                    aria-label="Duplicate step"
                    title="Duplicate step"
                  >
                    <Copy className="h-4 w-4 hover:text-signal-teal" />
                  </button>
                  <button
                    onClick={() =>
                      setEditor({ ...editor, steps: editor.steps.filter((_, xi) => xi !== i) })
                    }
                    aria-label="Remove step"
                  >
                    <Trash2 className="h-4 w-4 hover:text-spark-orange" />
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-parchment/40">{STEP_TYPE_HELP[step.type]}</p>
              <StepFields
                step={step}
                index={i}
                patchStep={patchStep}
                emailConns={emailConns}
                employees={employees}
                examples={examples}
              />
              <WhenEditor
                step={step}
                index={i}
                earlierVars={[...varsProducedBefore(editor.steps, i), ...ENGINE_PROVIDED_VARS]}
                patchStep={patchStep}
                examples={examples}
              />
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {FLOW_STEP_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => setEditor({ ...editor, steps: [...editor.steps, newStep(t, examples)] })}
                title={STEP_TYPE_HELP[t]}
                className="inline-flex items-center gap-1 rounded-md border border-parchment/15 px-2 py-1 text-xs text-parchment/70 hover:border-signal-teal hover:text-signal-teal"
              >
                <Plus className="h-3 w-3" /> {STEP_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          {editor.channel === "sms" && (
            <label className="flex items-center gap-2 text-sm text-parchment/70">
              <input
                type="checkbox"
                checked={editor.suppressDefaultReply}
                onChange={(ev) => setEditor({ ...editor, suppressDefaultReply: ev.target.checked })}
              />
              Suppress the normal Coworker reply when this flow matches
            </label>
          )}
          <label className="flex items-center gap-2 text-sm text-parchment/70">
            <input
              type="checkbox"
              checked={editor.enabled}
              onChange={(ev) => setEditor({ ...editor, enabled: ev.target.checked })}
            />
            Enabled
          </label>
        </section>

        <div className="flex justify-end gap-2">
          <button
            onClick={save}
            disabled={busy}
            className="rounded-md bg-spark-orange px-4 py-2 text-sm font-semibold text-deep-ink hover:bg-spark-orange/90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save AiFlow"}
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-md border border-spark-orange/40 bg-spark-orange/5 px-3 py-2 text-sm text-spark-orange">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <button
          onClick={() => setEditor(emptyEditor())}
          className="inline-flex items-center gap-1 rounded-md bg-signal-teal px-3 py-2 text-sm font-semibold text-deep-ink hover:bg-signal-teal/90"
        >
          <Plus className="h-4 w-4" /> New AiFlow
        </button>
      </div>
      {runNotice && (
        <p className="rounded-md border border-signal-teal/40 bg-signal-teal/5 px-3 py-2 text-sm text-signal-teal">
          {runNotice}
        </p>
      )}
      {flows.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">
            No AiFlows yet. Create one to automate a workflow — start it from a text, an
            email, a schedule, or run it on demand.
          </p>
        </Card>
      ) : (
        flows.map((row) => (
          <Card key={row.id} className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/dashboard/aiflows/${row.id}`}
                    className="truncate font-semibold text-parchment hover:text-signal-teal hover:underline"
                  >
                    {row.name}
                  </Link>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      row.enabled
                        ? "bg-claw-green/15 text-claw-green"
                        : "bg-parchment/10 text-parchment/50"
                    }`}
                  >
                    {row.enabled ? "ENABLED" : "OFF"}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-parchment/50">
                  {summarizeDefinition(row.definition)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-parchment/50">
                {row.enabled && (
                  <button
                    onClick={() => {
                      setRunNotice(null);
                      setRunInput("");
                      setRunFor(runFor === row.id ? null : row.id);
                    }}
                    className="text-xs text-signal-teal hover:underline"
                  >
                    Run now
                  </button>
                )}
                <button onClick={() => toggleEnabled(row)} className="text-xs hover:text-parchment">
                  {row.enabled ? "Disable" : "Enable"}
                </button>
                <button onClick={() => setEditor(editorFromRow(row))} aria-label="Edit">
                  <Pencil className="h-4 w-4 hover:text-signal-teal" />
                </button>
                <button
                  onClick={() => duplicateFlow(row)}
                  aria-label="Duplicate AiFlow"
                  title="Duplicate AiFlow"
                  disabled={busy}
                >
                  <Copy className="h-4 w-4 hover:text-signal-teal" />
                </button>
                <button onClick={() => remove(row.id)} aria-label="Delete" disabled={busy}>
                  <Trash2 className="h-4 w-4 hover:text-spark-orange" />
                </button>
              </div>
            </div>
            {runFor === row.id && (
              <div className="flex items-center gap-2 border-t border-parchment/10 pt-3">
                <input
                  className={inputClass}
                  value={runInput}
                  onChange={(ev) => setRunInput(ev.target.value)}
                  placeholder="Optional input — paste a link or message text for {{trigger.url}} / {{trigger.windowText}}"
                />
                <button
                  onClick={() => runNow(row)}
                  disabled={busy}
                  className="shrink-0 rounded-md bg-spark-orange px-3 py-2 text-sm font-semibold text-deep-ink hover:bg-spark-orange/90 disabled:opacity-50"
                >
                  {busy ? "Starting…" : "Start run"}
                </button>
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  );
}

/**
 * "From" mailbox picker shared by send_email and the send_sms quiet-hours
 * fallback: "" = the business's own AI coworker mailbox, otherwise a
 * workspace_oauth_connections.id (send as the owner's connected mailbox).
 * A stored id that no longer resolves to a connection is still shown (as
 * "connected mailbox (disconnected?)") so saving doesn't silently reset it.
 */
function FromMailboxSelect({
  value,
  onChange,
  emailConns
}: {
  value: string;
  onChange: (connectionId: string | undefined) => void;
  emailConns: EmailConnectionOption[];
}) {
  return (
    <div>
      <label className={labelClass}>From</label>
      <select
        className={inputClass}
        value={value}
        onChange={(ev) => onChange(ev.target.value || undefined)}
      >
        <option value="">Your AI coworker&apos;s email</option>
        {value && !emailConns.some((c) => c.id === value) && (
          <option value={value}>connected mailbox (disconnected?)</option>
        )}
        {emailConns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11px] text-parchment/40">
        Connect another mailbox under Settings → Integrations to see it here.
      </p>
    </div>
  );
}

/** Cap mirrors the schema's `.max(10)` on each of cc/bcc. */
const MAX_CC_BCC = 10;

/**
 * A cc/bcc editor: a comma-separated text input backed by a string[] plus an
 * "Add employee" dropdown that appends a roster member's email. Stores
 * `undefined` (not []) when empty so the schema strips the optional field.
 */
function RecipientListField({
  label,
  value,
  onChange,
  employees
}: {
  label: string;
  value: string[] | undefined;
  onChange: (list: string[] | undefined) => void;
  employees: EmployeeEmailOption[];
}) {
  const current = value ?? [];
  const commit = (list: string[]) => onChange(list.length > 0 ? list.slice(0, MAX_CC_BCC) : undefined);
  const addEmployee = (email: string) => {
    if (!email || current.some((e) => e.toLowerCase() === email.toLowerCase())) return;
    commit([...current, email]);
  };
  // Roster members not already in this list, so the picker never re-adds a dupe.
  const available = employees.filter(
    (m) => !current.some((e) => e.toLowerCase() === m.email.toLowerCase())
  );
  return (
    <div>
      <label className={labelClass}>{label}</label>
      <input
        className={inputClass}
        value={current.join(", ")}
        onChange={(e) =>
          commit(
            e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          )
        }
      />
      {available.length > 0 && (
        <select
          className={`${inputClass} mt-1`}
          value=""
          onChange={(e) => {
            addEmployee(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="">Add employee…</option>
          {available.map((m) => (
            <option key={m.email} value={m.email}>
              {m.name ? `${m.name} — ${m.email}` : m.email}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function StepFields({
  step,
  index,
  patchStep,
  emailConns,
  employees,
  examples
}: {
  step: FlowStep;
  index: number;
  patchStep: (index: number, patch: Record<string, unknown>) => void;
  emailConns: EmailConnectionOption[];
  employees: EmployeeEmailOption[];
  examples: AiFlowExampleCopy;
}) {
  if (step.type === "extract_url") {
    return (
      <Field
        label="Save the link as"
        value={step.saveAs}
        onChange={(v) => patchStep(index, { saveAs: v })}
        help="A short name for the link so later steps can reuse it (e.g. lead_url)."
      />
    );
  }
  if (step.type === "browse_extract") {
    return (
      <div className="space-y-2">
        <Field
          label="Which saved link to open"
          value={step.urlVar}
          onChange={(v) => patchStep(index, { urlVar: v })}
          help="The name of a link an earlier step saved (e.g. lead_url)."
        />
        <label className={labelClass}>Fields to extract</label>
        {step.fields.map((f, fi) => (
          <div key={fi} className="flex gap-2">
            <input
              className={inputClass}
              value={f.name}
              placeholder={examples.contactVar}
              onChange={(ev) =>
                patchStep(index, {
                  fields: step.fields.map((x, xi) =>
                    xi === fi ? { ...x, name: ev.target.value } : x
                  )
                })
              }
            />
            <input
              className={inputClass}
              value={f.description ?? ""}
              placeholder="description (optional)"
              onChange={(ev) =>
                patchStep(index, {
                  fields: step.fields.map((x, xi) =>
                    xi === fi ? { ...x, description: ev.target.value } : x
                  )
                })
              }
            />
          </div>
        ))}
        <button
          onClick={() => patchStep(index, { fields: [...step.fields, { name: "", description: "" }] })}
          className="text-xs text-signal-teal hover:underline"
        >
          + field
        </button>
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={step.screenshot ?? false}
            onChange={(ev) =>
              // Optional: round-trip false as undefined so it's dropped on save.
              patchStep(index, { screenshot: ev.target.checked ? true : undefined })
            }
          />
          Capture a screenshot of the page
        </label>
      </div>
    );
  }
  if (step.type === "extract_text") {
    return (
      <div className="space-y-2">
        <p className="text-xs text-parchment/50">
          Reads these details straight from the incoming message - no link needed.
        </p>
        <label className={labelClass}>Fields to extract</label>
        {step.fields.map((f, fi) => (
          <div key={fi} className="flex gap-2">
            <input
              className={inputClass}
              value={f.name}
              placeholder={examples.contactVar}
              onChange={(ev) =>
                patchStep(index, {
                  fields: step.fields.map((x, xi) =>
                    xi === fi ? { ...x, name: ev.target.value } : x
                  )
                })
              }
            />
            <input
              className={inputClass}
              value={f.description ?? ""}
              placeholder="description (optional)"
              onChange={(ev) =>
                patchStep(index, {
                  fields: step.fields.map((x, xi) =>
                    xi === fi ? { ...x, description: ev.target.value } : x
                  )
                })
              }
            />
          </div>
        ))}
        <button
          onClick={() => patchStep(index, { fields: [...step.fields, { name: "", description: "" }] })}
          className="text-xs text-signal-teal hover:underline"
        >
          + field
        </button>
      </div>
    );
  }
  if (step.type === "send_sms") {
    const qh = step.quietHours;
    return (
      <div className="space-y-2">
        <Field label="Recipient" value={step.to} onChange={(v) => patchStep(index, { to: v })} />
        <Field label="Message" value={step.body} onChange={(v) => patchStep(index, { body: v })} textarea />
        <div className="rounded-md border border-parchment/10 bg-deep-ink/30 px-3 py-2 space-y-2">
          <label className="flex items-center gap-2 text-xs text-parchment/70">
            <input
              type="checkbox"
              checked={Boolean(qh)}
              onChange={(ev) =>
                patchStep(index, {
                  quietHours: ev.target.checked
                    ? {
                        timezone: "America/Phoenix",
                        noSendAfter: "22:00",
                        resumeAt: "08:30"
                      }
                    : undefined
                })
              }
            />
            Quiet hours
          </label>
          {qh && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Field
                  label="Time zone"
                  value={qh.timezone}
                  onChange={(v) => patchStep(index, { quietHours: { ...qh, timezone: v } })}
                />
                <Field
                  label="No texts after"
                  value={qh.noSendAfter}
                  onChange={(v) => patchStep(index, { quietHours: { ...qh, noSendAfter: v } })}
                />
                <Field
                  label="Resume texting at"
                  value={qh.resumeAt}
                  onChange={(v) => patchStep(index, { quietHours: { ...qh, resumeAt: v } })}
                />
              </div>
              <Field
                label="After-hours email — variable holding the lead's email (optional; emailed right away while the text waits until morning)"
                value={qh.emailFallbackVar ?? ""}
                onChange={(v) =>
                  patchStep(index, {
                    quietHours: { ...qh, emailFallbackVar: v.trim() ? v.trim() : undefined }
                  })
                }
              />
              {qh.emailFallbackVar && (
                <>
                  <Field
                    label="Fallback email subject"
                    value={qh.emailSubject ?? ""}
                    onChange={(v) =>
                      patchStep(index, {
                        quietHours: { ...qh, emailSubject: v.trim() ? v : undefined }
                      })
                    }
                  />
                  <FromMailboxSelect
                    value={qh.emailFromConnectionId ?? ""}
                    onChange={(connectionId) =>
                      patchStep(index, {
                        quietHours: { ...qh, emailFromConnectionId: connectionId }
                      })
                    }
                    emailConns={emailConns}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (step.type === "send_email") {
    return (
      <div className="space-y-2">
        <Field
          label="Recipient email"
          value={step.to}
          onChange={(v) => patchStep(index, { to: v })}
        />
        <RecipientListField
          label="Cc (optional, comma-separated)"
          value={step.cc}
          onChange={(list) => patchStep(index, { cc: list })}
          employees={employees}
        />
        <RecipientListField
          label="Bcc (optional, comma-separated)"
          value={step.bcc}
          onChange={(list) => patchStep(index, { bcc: list })}
          employees={employees}
        />
        <FromMailboxSelect
          value={step.fromConnectionId ?? ""}
          onChange={(connectionId) => patchStep(index, { fromConnectionId: connectionId })}
          emailConns={emailConns}
        />
        <Field
          label={`Subject (e.g. ${examples.emailSubjectExample})`}
          value={step.subject}
          onChange={(v) => patchStep(index, { subject: v })}
        />
        <Field label="Body" value={step.body} onChange={(v) => patchStep(index, { body: v })} textarea />
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={step.attachScreenshot ?? false}
            onChange={(ev) =>
              patchStep(index, { attachScreenshot: ev.target.checked ? true : undefined })
            }
          />
          Attach the screenshot from an earlier browse step (AI coworker email only)
        </label>
      </div>
    );
  }
  if (step.type === "approval_gate") {
    return (
      <Field label="Approval prompt" value={step.prompt} onChange={(v) => patchStep(index, { prompt: v })} />
    );
  }
  if (step.type === "notify_owner") {
    return (
      <Field
        label="Owner message"
        value={step.message}
        onChange={(v) => patchStep(index, { message: v })}
        textarea
      />
    );
  }
  if (step.type === "route_to_team") {
    const ow = step.offerWindow;
    return (
      <div className="space-y-2">
        <Field
          label="Agent offer SMS (use {{agent.name}} / {{offer.deadline}}, reply 1=claim / 2=pass)"
          value={step.offerTemplate}
          onChange={(v) => patchStep(index, { offerTemplate: v })}
          textarea
        />
        <Field
          label="Minutes to respond before escalating"
          value={String(step.responseMinutes ?? 10)}
          onChange={(v) => {
            const n = Number(v);
            patchStep(index, { responseMinutes: Number.isFinite(n) && n > 0 ? Math.round(n) : 10 });
          }}
        />
        <Field
          label={`Pin to one team member by name (optional — e.g. ${examples.pinExample})`}
          value={step.agentName ?? ""}
          onChange={(v) => patchStep(index, { agentName: v.trim() ? v : undefined })}
        />
        <Field
          label="Owner fallback SMS (when no agent claims)"
          value={step.ownerFallbackTemplate}
          onChange={(v) => patchStep(index, { ownerFallbackTemplate: v })}
          textarea
        />
        <Field
          label="Owner notice when claimed (optional)"
          value={step.claimedNotifyTemplate ?? ""}
          onChange={(v) =>
            // Optional: an empty value must round-trip as undefined, not "",
            // since the schema requires min(1) when the key is present.
            patchStep(index, { claimedNotifyTemplate: v.trim() ? v : undefined })
          }
          textarea
        />
        <div className="rounded-md border border-parchment/10 bg-deep-ink/30 px-3 py-2 space-y-2">
          <label className="flex items-center gap-2 text-xs text-parchment/70">
            <input
              type="checkbox"
              checked={Boolean(ow)}
              onChange={(ev) =>
                patchStep(index, {
                  offerWindow: ev.target.checked
                    ? {
                        timezone: "America/Phoenix",
                        quietStart: "21:00",
                        quietEnd: "08:30",
                        graceMinutes: 10
                      }
                    : undefined
                })
              }
            />
            After-hours offers — the claim countdown starts in the morning
          </label>
          {ow && (
            <div className="flex flex-wrap gap-2">
              <Field
                label="Time zone"
                value={ow.timezone}
                onChange={(v) => patchStep(index, { offerWindow: { ...ow, timezone: v } })}
              />
              <Field
                label="Quiet from"
                value={ow.quietStart}
                onChange={(v) => patchStep(index, { offerWindow: { ...ow, quietStart: v } })}
              />
              <Field
                label="Until"
                value={ow.quietEnd}
                onChange={(v) => patchStep(index, { offerWindow: { ...ow, quietEnd: v } })}
              />
              <Field
                label="Grace minutes"
                value={String(ow.graceMinutes ?? 10)}
                onChange={(v) => {
                  const n = Number(v);
                  patchStep(index, {
                    offerWindow: {
                      ...ow,
                      graceMinutes: Number.isFinite(n) && n >= 0 ? Math.round(n) : 10
                    }
                  });
                }}
              />
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={step.attachScreenshot ?? false}
            onChange={(ev) =>
              patchStep(index, { attachScreenshot: ev.target.checked ? true : undefined })
            }
          />
          Attach the screenshot from an earlier browse step to each agent offer (MMS)
        </label>
      </div>
    );
  }
  if (step.type === "browse_action") {
    return (
      <div className="space-y-2">
        <Field label="URL variable" value={step.urlVar} onChange={(v) => patchStep(index, { urlVar: v })} />
        <Field
          label="Login integration label (optional — for pages behind the owner's account)"
          value={step.auth?.integrationLabel ?? ""}
          onChange={(v) =>
            patchStep(index, { auth: v.trim() ? { integrationLabel: v } : undefined })
          }
        />
        <label className={labelClass}>
          Page actions, in order (use {"{{vars.actions_taken}}"} in a fill value to describe what this flow did)
        </label>
        {step.actions.map((a, ai) => (
          <div key={ai} className="flex flex-wrap items-center gap-2">
            <select
              className={`${inputClass} w-auto`}
              value={a.kind}
              onChange={(ev) =>
                patchStep(index, {
                  actions: step.actions.map((x, xi) =>
                    xi === ai ? { ...x, kind: ev.target.value as (typeof BROWSE_ACTION_KINDS)[number] } : x
                  )
                })
              }
            >
              {BROWSE_ACTION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {BROWSE_ACTION_LABELS[k]}
                </option>
              ))}
            </select>
            <input
              className={`${inputClass} flex-1`}
              value={a.target}
              placeholder={a.kind.endsWith("_selector") ? "CSS selector" : "visible text / placeholder"}
              onChange={(ev) =>
                patchStep(index, {
                  actions: step.actions.map((x, xi) =>
                    xi === ai ? { ...x, target: ev.target.value } : x
                  )
                })
              }
            />
            {a.kind.startsWith("fill") && (
              <input
                className={`${inputClass} flex-1`}
                value={a.valueTemplate ?? ""}
                placeholder="value to type"
                onChange={(ev) =>
                  patchStep(index, {
                    actions: step.actions.map((x, xi) =>
                      xi === ai
                        ? { ...x, valueTemplate: ev.target.value ? ev.target.value : undefined }
                        : x
                    )
                  })
                }
              />
            )}
            <button
              onClick={() =>
                patchStep(index, { actions: step.actions.filter((_, xi) => xi !== ai) })
              }
              className="text-parchment/40 hover:text-spark-orange"
              aria-label="Remove action"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            patchStep(index, {
              actions: [...step.actions, { kind: "click_text", target: "" }]
            })
          }
          className="text-xs text-signal-teal hover:underline"
        >
          + action
        </button>
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={step.screenshot ?? false}
            onChange={(ev) =>
              patchStep(index, { screenshot: ev.target.checked ? true : undefined })
            }
          />
          Capture a screenshot after the actions (audit trail)
        </label>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Field label="Integration label" value={step.label} onChange={(v) => patchStep(index, { label: v })} />
      <div>
        <label className={labelClass}>Method</label>
        <select
          className={inputClass}
          value={step.method ?? "POST"}
          onChange={(ev) => patchStep(index, { method: ev.target.value })}
        >
          {HTTP_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <Field label="Path" value={step.path ?? ""} onChange={(v) => patchStep(index, { path: v })} />
      <Field
        label="Body template"
        value={step.bodyTemplate ?? ""}
        onChange={(v) => patchStep(index, { bodyTemplate: v })}
        textarea
      />
      <Field
        label="Save response as"
        value={step.saveAs ?? ""}
        onChange={(v) => patchStep(index, { saveAs: v })}
      />
    </div>
  );
}

/**
 * Optional "Only run when" guard per step. Lets the author gate a step on a var
 * an EARLIER step produced (e.g. run the buyer SMS only when lead_type contains
 * "buyer"). Writes `when` straight onto the step so the zod schema round-trips
 * it; toggling off clears it (undefined → dropped on JSON save).
 */
function WhenEditor({
  step,
  index,
  earlierVars,
  patchStep,
  examples
}: {
  step: FlowStep;
  index: number;
  earlierVars: string[];
  patchStep: (index: number, patch: Record<string, unknown>) => void;
  examples: AiFlowExampleCopy;
}) {
  const when = step.when;
  const operator: "contains" | "equals" = when?.equals !== undefined ? "equals" : "contains";
  const value = when?.equals ?? when?.contains ?? "";

  const setWhen = (next: StepCondition) => patchStep(index, { when: next });

  const buildWhen = (over: Partial<{ var: string; operator: "contains" | "equals"; value: string }>) => {
    const v = over.var ?? when?.var ?? earlierVars[0] ?? "";
    const op = over.operator ?? operator;
    const val = over.value ?? value;
    const base: StepCondition =
      op === "equals" ? { var: v, equals: val } : { var: v, contains: val };
    // Carry through a non-default caseInsensitive flag set elsewhere (e.g. AI
    // authoring or a hand-edited definition); the editor doesn't surface it, so
    // rebuilding the object would otherwise silently reset it to the default.
    if (when?.caseInsensitive !== undefined) base.caseInsensitive = when.caseInsensitive;
    return base;
  };

  return (
    <div className="rounded-md border border-parchment/10 bg-deep-ink/30 px-3 py-2">
      <label className="flex items-center gap-2 text-xs text-parchment/70">
        <input
          type="checkbox"
          checked={Boolean(when)}
          onChange={(ev) =>
            patchStep(index, { when: ev.target.checked ? buildWhen({}) : undefined })
          }
        />
        Only run when…
      </label>
      {when && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            className={`${inputClass} w-auto`}
            value={when.var}
            onChange={(ev) => setWhen(buildWhen({ var: ev.target.value }))}
          >
            {earlierVars.length === 0 && <option value="">(no earlier variables)</option>}
            {!earlierVars.includes(when.var) && when.var !== "" && (
              <option value={when.var}>{when.var}</option>
            )}
            {earlierVars.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <select
            className={`${inputClass} w-auto`}
            value={operator}
            onChange={(ev) =>
              setWhen(buildWhen({ operator: ev.target.value as "contains" | "equals" }))
            }
          >
            <option value="contains">contains</option>
            <option value="equals">equals</option>
          </select>
          <input
            className={`${inputClass} flex-1`}
            value={value}
            placeholder={examples.whenValuePlaceholder}
            onChange={(ev) => setWhen(buildWhen({ value: ev.target.value }))}
          />
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  textarea,
  help
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
  help?: string;
}) {
  return (
    <div>
      <label className={labelClass}>{label}</label>
      {textarea ? (
        <textarea className={inputClass} rows={2} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {help && <p className="mt-1 text-[11px] text-parchment/40">{help}</p>}
    </div>
  );
}
