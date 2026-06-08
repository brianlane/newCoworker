"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Plus, Trash2, ArrowUp, ArrowDown, Sparkles, Pencil } from "lucide-react";
import {
  FLOW_STEP_TYPES,
  TRIGGER_CONDITION_TYPES,
  HTTP_METHODS,
  summarizeDefinition,
  type AiFlowDefinition,
  type FlowStep,
  type StepCondition,
  type TriggerCondition
} from "@/lib/ai-flows/schema";
import type { AiFlowRow } from "@/lib/ai-flows/db";

const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none";
const labelClass = "block text-xs font-medium text-parchment/60 mb-1";

type EditorState = {
  id: string | null;
  name: string;
  enabled: boolean;
  suppressDefaultReply: boolean;
  correlationWindowMinutes: number;
  conditions: TriggerCondition[];
  steps: FlowStep[];
};

function emptyEditor(): EditorState {
  return {
    id: null,
    name: "",
    enabled: false,
    suppressDefaultReply: false,
    correlationWindowMinutes: 10,
    conditions: [{ type: "has_url" }],
    steps: []
  };
}

function editorFromRow(row: AiFlowRow): EditorState {
  const def = row.definition;
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    suppressDefaultReply: def.options?.suppressDefaultReply ?? false,
    correlationWindowMinutes: def.trigger.correlationWindowMinutes ?? 10,
    conditions: def.trigger.conditions,
    steps: def.steps
  };
}

function newStep(type: FlowStep["type"]): FlowStep {
  const id = `s_${(crypto.randomUUID?.() ?? String(Date.now())).slice(0, 8)}`;
  switch (type) {
    case "extract_url":
      return { id, type, saveAs: "lead_url" };
    case "browse_extract":
      return { id, type, urlVar: "lead_url", fields: [{ name: "seller_phone", description: "" }] };
    case "send_sms":
      return { id, type, to: "{{vars.seller_phone}}", body: "" };
    case "approval_gate":
      return { id, type, prompt: "Send this message?" };
    case "notify_owner":
      return { id, type, message: "" };
    case "http_call":
      return { id, type, label: "", method: "POST", path: "", bodyTemplate: "", saveAs: "" };
  }
}

/** Vars a single step produces (visible to LATER steps). Mirrors schema scope. */
function varsProducedByStep(step: FlowStep): string[] {
  if (step.type === "extract_url") return [step.saveAs];
  if (step.type === "browse_extract") return step.fields.map((f) => f.name).filter(Boolean);
  if (step.type === "http_call" && step.saveAs) return [step.saveAs];
  return [];
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

function toDefinition(s: EditorState): AiFlowDefinition {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: s.correlationWindowMinutes,
      conditions: s.conditions
    },
    steps: s.steps,
    options: { suppressDefaultReply: s.suppressDefaultReply }
  };
}

export function AiFlowsManager({
  businessId,
  initialFlows
}: {
  businessId: string;
  initialFlows: AiFlowRow[];
}) {
  const [flows, setFlows] = useState<AiFlowRow[]>(initialFlows);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

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
        enabled: e?.enabled ?? false,
        suppressDefaultReply: def.options?.suppressDefaultReply ?? false,
        correlationWindowMinutes: def.trigger.correlationWindowMinutes ?? 10,
        conditions: def.trigger.conditions,
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
            placeholder="ReferralExchange lead follow-up"
          />
        </div>

        <div className="rounded-md border border-parchment/10 bg-deep-ink/20 p-4 space-y-3">
          <div className="flex items-center gap-2 text-parchment/70">
            <Sparkles className="h-4 w-4 text-signal-teal" />
            <span className="text-sm font-medium">Generate with AI</span>
          </div>
          <textarea
            className={inputClass}
            rows={2}
            value={aiPrompt}
            onChange={(ev) => setAiPrompt(ev.target.value)}
            placeholder="When a ReferralExchange lead texts a link, open it, get the seller's phone, ask me to approve, then text them."
          />
          <button
            onClick={generateWithAi}
            disabled={aiBusy}
            className="rounded-md bg-signal-teal/20 px-3 py-1.5 text-sm text-signal-teal hover:bg-signal-teal/30 disabled:opacity-50"
          >
            {aiBusy ? "Generating…" : "Generate steps"}
          </button>
        </div>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-parchment/40">Trigger</h3>
          <div>
            <label className={labelClass}>Correlation window (minutes)</label>
            <input
              type="number"
              className={inputClass}
              value={editor.correlationWindowMinutes}
              onChange={(ev) =>
                setEditor({ ...editor, correlationWindowMinutes: Number(ev.target.value) || 0 })
              }
            />
          </div>
          {editor.conditions.map((c, i) => (
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
                    {t}
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
          <button
            onClick={() =>
              setEditor({ ...editor, conditions: [...editor.conditions, { type: "contains", value: "" }] })
            }
            className="inline-flex items-center gap-1 text-sm text-signal-teal hover:underline"
          >
            <Plus className="h-3 w-3" /> Add condition
          </button>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-parchment/40">Steps</h3>
          {editor.steps.map((step, i) => (
            <div key={step.id} className="rounded-md border border-parchment/10 bg-deep-ink/20 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-parchment">
                  {i + 1}. {step.type}
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
                      setEditor({ ...editor, steps: editor.steps.filter((_, xi) => xi !== i) })
                    }
                    aria-label="Remove step"
                  >
                    <Trash2 className="h-4 w-4 hover:text-spark-orange" />
                  </button>
                </div>
              </div>
              <StepFields step={step} index={i} patchStep={patchStep} />
              <WhenEditor
                step={step}
                index={i}
                earlierVars={varsProducedBefore(editor.steps, i)}
                patchStep={patchStep}
              />
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {FLOW_STEP_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => setEditor({ ...editor, steps: [...editor.steps, newStep(t)] })}
                className="inline-flex items-center gap-1 rounded-md border border-parchment/15 px-2 py-1 text-xs text-parchment/70 hover:border-signal-teal hover:text-signal-teal"
              >
                <Plus className="h-3 w-3" /> {t}
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-parchment/70">
            <input
              type="checkbox"
              checked={editor.suppressDefaultReply}
              onChange={(ev) => setEditor({ ...editor, suppressDefaultReply: ev.target.checked })}
            />
            Suppress the normal Coworker reply when this flow matches
          </label>
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
      <div className="flex justify-end">
        <button
          onClick={() => setEditor(emptyEditor())}
          className="inline-flex items-center gap-1 rounded-md bg-spark-orange px-3 py-2 text-sm font-semibold text-deep-ink hover:bg-spark-orange/90"
        >
          <Plus className="h-4 w-4" /> New AiFlow
        </button>
      </div>
      {flows.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/60">
            No AiFlows yet. Create one to automate actions on inbound texts.
          </p>
        </Card>
      ) : (
        flows.map((row) => (
          <Card key={row.id} className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="truncate font-semibold text-parchment">{row.name}</h3>
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
              <button onClick={() => toggleEnabled(row)} className="text-xs hover:text-parchment">
                {row.enabled ? "Disable" : "Enable"}
              </button>
              <button onClick={() => setEditor(editorFromRow(row))} aria-label="Edit">
                <Pencil className="h-4 w-4 hover:text-signal-teal" />
              </button>
              <button onClick={() => remove(row.id)} aria-label="Delete" disabled={busy}>
                <Trash2 className="h-4 w-4 hover:text-spark-orange" />
              </button>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

function StepFields({
  step,
  index,
  patchStep
}: {
  step: FlowStep;
  index: number;
  patchStep: (index: number, patch: Record<string, unknown>) => void;
}) {
  if (step.type === "extract_url") {
    return (
      <Field
        label="Save URL as variable"
        value={step.saveAs}
        onChange={(v) => patchStep(index, { saveAs: v })}
      />
    );
  }
  if (step.type === "browse_extract") {
    return (
      <div className="space-y-2">
        <Field label="URL variable" value={step.urlVar} onChange={(v) => patchStep(index, { urlVar: v })} />
        <label className={labelClass}>Fields to extract</label>
        {step.fields.map((f, fi) => (
          <div key={fi} className="flex gap-2">
            <input
              className={inputClass}
              value={f.name}
              placeholder="seller_phone"
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
    return (
      <div className="space-y-2">
        <Field label="Recipient" value={step.to} onChange={(v) => patchStep(index, { to: v })} />
        <Field label="Message" value={step.body} onChange={(v) => patchStep(index, { body: v })} textarea />
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
  patchStep
}: {
  step: FlowStep;
  index: number;
  earlierVars: string[];
  patchStep: (index: number, patch: Record<string, unknown>) => void;
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
            placeholder="buyer"
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
  textarea
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
}) {
  return (
    <div>
      <label className={labelClass}>{label}</label>
      {textarea ? (
        <textarea className={inputClass} rows={2} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}
