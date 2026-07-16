"use client";

/**
 * Agents manager (Dashboard → Agents).
 *
 * An agent is a saved, reusable task: name + instructions + output format.
 * The owner runs it against an attachment — a fresh upload (PDF / text /
 * markdown / CSV) or an existing business document — and gets the same kind
 * of output every time. Each expanded agent shows a run panel and run
 * history with the produced artifact (view / copy / download / save into
 * the Documents knowledge library).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

type AgentItem = {
  id: string;
  name: string;
  instructions: string;
  output_format: "markdown" | "same_as_input";
  enabled: boolean;
  created_at: string;
};

type RunItem = {
  id: string;
  status: "running" | "succeeded" | "failed";
  source: "manual" | "flow";
  input_document_id: string | null;
  input_filename: string;
  output_md: string;
  output_filename: string;
  error_detail: string | null;
  created_at: string;
};

type DocumentOption = {
  id: string;
  title: string;
  status: string;
};

const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none";
const labelClass = "block text-xs font-medium text-parchment/60 mb-1";

const FORMAT_LABELS: Record<AgentItem["output_format"], string> = {
  markdown: "Markdown",
  same_as_input: "Same as input"
};

export function AgentsManager({
  businessId,
  initialDraft
}: {
  businessId: string;
  /** When true (`?draft=1`), load the chat-created draft stashed in sessionStorage. */
  initialDraft?: boolean;
}) {
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form.
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createInstructions, setCreateInstructions] = useState("");
  const [createFormat, setCreateFormat] = useState<AgentItem["output_format"]>("markdown");
  const [creating, setCreating] = useState(false);

  // Per-agent expanded panel. The ref mirrors openId so async fetches can
  // verify the SAME agent is still expanded before applying results.
  const [openId, setOpenId] = useState<string | null>(null);
  const openIdRef = useRef<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftInstructions, setDraftInstructions] = useState("");
  const [draftFormat, setDraftFormat] = useState<AgentItem["output_format"]>("markdown");
  const [savingAgent, setSavingAgent] = useState(false);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [documents, setDocuments] = useState<DocumentOption[]>([]);
  const [runDocumentId, setRunDocumentId] = useState("");
  const [running, setRunning] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [savingRunDoc, setSavingRunDoc] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const runFileRef = useRef<HTMLInputElement | null>(null);

  // Chat hand-off: /dashboard/chat's "create an agent" tool stashes the
  // draft in sessionStorage then navigates here with ?draft=1. Load it once
  // into the create form for review, then clear the stash so a refresh
  // doesn't re-open it. Nothing is saved until the owner clicks Create.
  useEffect(() => {
    if (!initialDraft) return;
    try {
      const raw = sessionStorage.getItem("agent_create_draft");
      if (!raw) return;
      const draft = JSON.parse(raw) as {
        name?: unknown;
        instructions?: unknown;
        outputFormat?: unknown;
      };
      if (typeof draft.name === "string" && typeof draft.instructions === "string") {
        sessionStorage.removeItem("agent_create_draft");
        setCreateName(draft.name.slice(0, 120));
        setCreateInstructions(draft.instructions.slice(0, 8000));
        setCreateFormat(draft.outputFormat === "same_as_input" ? "same_as_input" : "markdown");
        setShowCreate(true);
      }
    } catch {
      /* malformed/absent draft — fall back to the normal list view */
    }
  }, [initialDraft]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/agents?businessId=${encodeURIComponent(businessId)}`, {
        cache: "no-store"
      });
      const json = (await res.json()) as { ok: boolean; data?: { agents?: AgentItem[] } };
      if (json.ok && json.data?.agents) setAgents(json.data.agents);
    } catch {
      /* keep the last list */
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function refreshRuns(agentId: string) {
    try {
      const res = await fetch(
        `/api/dashboard/agents/${agentId}/runs?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as { ok: boolean; data?: { runs?: RunItem[] } };
      if (openIdRef.current === agentId && json.ok && json.data?.runs) setRuns(json.data.runs);
    } catch {
      /* runs panel stays as-is */
    }
  }

  async function openAgent(agent: AgentItem) {
    if (openId === agent.id) {
      setOpenId(null);
      openIdRef.current = null;
      return;
    }
    setOpenId(agent.id);
    openIdRef.current = agent.id;
    setDraftName(agent.name);
    setDraftInstructions(agent.instructions);
    setDraftFormat(agent.output_format);
    setRuns([]);
    setRunDocumentId("");
    // Clear any attachment left over from another agent's run panel — the
    // file input is shared across panels and runAgent prefers it over the
    // document picker.
    if (runFileRef.current) runFileRef.current.value = "";
    setOpenRunId(null);
    setNotice(null);
    setError(null);
    await refreshRuns(agent.id);
    try {
      const res = await fetch(
        `/api/dashboard/documents?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as { ok: boolean; data?: { documents?: DocumentOption[] } };
      if (openIdRef.current === agent.id && json.ok && json.data?.documents) {
        setDocuments(json.data.documents.filter((d) => d.status === "ready"));
      }
    } catch {
      /* document picker stays empty; uploads still work */
    }
  }

  async function createAgent() {
    if (!createName.trim() || !createInstructions.trim()) {
      setError("Give the agent a name and instructions.");
      return;
    }
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/dashboard/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessId,
          name: createName.trim(),
          instructions: createInstructions.trim(),
          outputFormat: createFormat
        })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Creating the agent failed");
        return;
      }
      setCreateName("");
      setCreateInstructions("");
      setCreateFormat("markdown");
      setShowCreate(false);
      await refresh();
    } catch {
      setError("Creating the agent failed — try again.");
    } finally {
      setCreating(false);
    }
  }

  async function saveAgent(agent: AgentItem) {
    setSavingAgent(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessId,
          name: draftName.trim() || agent.name,
          instructions: draftInstructions.trim() || agent.instructions,
          outputFormat: draftFormat
        })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Saving failed");
        return;
      }
      setNotice("Agent saved.");
      await refresh();
    } catch {
      setError("Saving failed — try again.");
    } finally {
      setSavingAgent(false);
    }
  }

  async function toggleEnabled(agent: AgentItem) {
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId, enabled: !agent.enabled })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) setError(json.error?.message ?? "Update failed");
      await refresh();
    } catch {
      setError("Update failed — try again.");
    }
  }

  async function deleteAgent(agent: AgentItem) {
    if (!window.confirm(`Delete the "${agent.name}" agent and its run history?`)) return;
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/agents/${agent.id}?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE" }
      );
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Delete failed");
        return;
      }
      if (openId === agent.id) {
        setOpenId(null);
        openIdRef.current = null;
      }
      await refresh();
    } catch {
      setError("Delete failed — try again.");
    }
  }

  async function runAgent(agent: AgentItem) {
    const file = runFileRef.current?.files?.[0];
    if (!file && !runDocumentId) {
      setError("Attach a file or pick a document to run on.");
      return;
    }
    setError(null);
    setNotice(null);
    setRunning(true);
    try {
      let res: Response;
      if (file) {
        const form = new FormData();
        form.set("businessId", businessId);
        form.set("file", file);
        res = await fetch(`/api/dashboard/agents/${agent.id}/run`, {
          method: "POST",
          body: form
        });
      } else {
        res = await fetch(`/api/dashboard/agents/${agent.id}/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ businessId, documentId: runDocumentId })
        });
      }
      const json = (await res.json()) as {
        ok: boolean;
        data?: { run?: RunItem };
        error?: { message?: string };
      };
      if (!json.ok) {
        setError(json.error?.message ?? "Run failed");
        return;
      }
      if (runFileRef.current) runFileRef.current.value = "";
      setRunDocumentId("");
      const run = json.data?.run;
      if (run) setOpenRunId(run.id);
      if (run?.status === "failed") {
        setError(run.error_detail ?? "Run failed");
      }
      await refreshRuns(agent.id);
    } catch {
      setError("Run failed — try again.");
    } finally {
      setRunning(false);
    }
  }

  async function copyOutput(run: RunItem) {
    try {
      await navigator.clipboard.writeText(run.output_md);
      setNotice("Output copied to clipboard.");
    } catch {
      setError("Copy failed — select the text manually.");
    }
  }

  async function saveRunAsDocument(run: RunItem) {
    setSavingRunDoc(run.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/dashboard/agents/runs/${run.id}/save-document`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Saving as a document failed");
        return;
      }
      setNotice("Saved to Documents (Memory page) as an internal document.");
    } catch {
      setError("Saving as a document failed — try again.");
    } finally {
      setSavingRunDoc(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-parchment">Your agents</h2>
            <p className="text-xs text-parchment/50 mt-0.5">
              Example: &ldquo;Turn this intake form into a clean client summary&rdquo; — save it
              once, run it on every new form.
            </p>
          </div>
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Close" : "New agent"}
          </Button>
        </div>

        {showCreate && (
          <div className="mt-4 space-y-3 border-t border-parchment/10 pt-4">
            <div>
              <label className={labelClass}>Name</label>
              <input
                className={inputClass}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="Intake form summarizer"
                maxLength={120}
              />
            </div>
            <div>
              <label className={labelClass}>Instructions (what to do with each attachment)</label>
              <textarea
                className={`${inputClass} min-h-28`}
                value={createInstructions}
                onChange={(e) => setCreateInstructions(e.target.value)}
                placeholder="Summarize the attached intake form into: client name, requested service, budget, timeline, and any special requests. Use short bullet points."
                maxLength={8000}
              />
            </div>
            <div>
              <label className={labelClass}>Output format</label>
              <select
                className={inputClass}
                value={createFormat}
                onChange={(e) => setCreateFormat(e.target.value as AgentItem["output_format"])}
              >
                <option value="markdown">Markdown (works for everything)</option>
                <option value="same_as_input">Same as input (CSV in → CSV out)</option>
              </select>
            </div>
            <Button size="sm" onClick={createAgent} disabled={creating}>
              {creating ? "Creating…" : "Create agent"}
            </Button>
          </div>
        )}
      </Card>

      {error && (
        <Card className="border-spark-orange/40 bg-spark-orange/5">
          <p className="text-sm text-spark-orange whitespace-pre-wrap">{error}</p>
        </Card>
      )}
      {notice && (
        <Card className="border-claw-green/40 bg-claw-green/5">
          <p className="text-sm text-claw-green">{notice}</p>
        </Card>
      )}

      {loading ? (
        <Card>
          <p className="text-sm text-parchment/50">Loading agents…</p>
        </Card>
      ) : agents.length === 0 ? (
        <Card>
          <p className="text-sm text-parchment/60">
            No agents yet. Create one above — save the instructions once, then run it on any
            attachment.
          </p>
        </Card>
      ) : (
        agents.map((agent) => (
          <Card key={agent.id}>
            <button
              type="button"
              className="w-full text-left flex items-start justify-between gap-3"
              onClick={() => void openAgent(agent)}
            >
              <div className="min-w-0">
                {/* Clamp to two lines (not single-line truncate) so long agent
                    names stay readable on phones; tooltip carries the rest. */}
                <p
                  className="text-sm font-semibold text-parchment break-words line-clamp-2"
                  title={agent.name}
                >
                  {agent.name}
                  {!agent.enabled && (
                    <span className="ml-2 rounded border border-parchment/20 px-1.5 py-0.5 text-[10px] text-parchment/50 align-middle">
                      Disabled
                    </span>
                  )}
                </p>
                <p className="text-xs text-parchment/50 truncate mt-0.5" title={agent.instructions}>
                  {agent.instructions}
                </p>
              </div>
              <span className="shrink-0 self-start rounded border border-parchment/20 px-1.5 py-0.5 text-[10px] text-parchment/50">
                {FORMAT_LABELS[agent.output_format]}
              </span>
            </button>

            {openId === agent.id && (
              <div className="mt-4 space-y-4 border-t border-parchment/10 pt-4">
                {/* Run panel */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-parchment/70 uppercase tracking-wide">
                    Run
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      ref={runFileRef}
                      type="file"
                      accept=".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv"
                      className="text-xs text-parchment/60 file:mr-3 file:rounded-md file:border-0 file:bg-parchment/10 file:px-3 file:py-1.5 file:text-xs file:text-parchment"
                      onChange={() => setRunDocumentId("")}
                    />
                    <select
                      className={`${inputClass} sm:max-w-56`}
                      value={runDocumentId}
                      onChange={(e) => {
                        setRunDocumentId(e.target.value);
                        if (e.target.value && runFileRef.current) runFileRef.current.value = "";
                      }}
                    >
                      <option value="">…or pick a document</option>
                      {documents.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.title}
                        </option>
                      ))}
                    </select>
                    <Button size="sm" onClick={() => void runAgent(agent)} disabled={running}>
                      {running ? "Running…" : "Run agent"}
                    </Button>
                  </div>
                  <p className="text-[11px] text-parchment/40">
                    PDF, text, markdown, or CSV up to 10 MB. Runs use your plan&rsquo;s shared AI
                    budget.
                  </p>
                </div>

                {/* Run history */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-parchment/70 uppercase tracking-wide">
                    Recent runs
                  </p>
                  {runs.length === 0 ? (
                    <p className="text-xs text-parchment/40">No runs yet.</p>
                  ) : (
                    runs.map((run) => (
                      <div key={run.id} className="rounded-md border border-parchment/10 p-2">
                        <button
                          type="button"
                          className="w-full text-left flex items-center justify-between gap-2"
                          onClick={() => setOpenRunId(openRunId === run.id ? null : run.id)}
                        >
                          <span className="text-xs text-parchment/70 truncate">
                            {run.input_filename || "attachment"}
                            <span className="text-parchment/40">
                              {" "}
                              · {new Date(run.created_at).toLocaleString()}
                              {run.source === "flow" ? " · via AiFlow" : ""}
                            </span>
                          </span>
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] border ${
                              run.status === "succeeded"
                                ? "text-claw-green border-claw-green/40"
                                : run.status === "failed"
                                  ? "text-spark-orange border-spark-orange/40"
                                  : "text-parchment/50 border-parchment/20"
                            }`}
                          >
                            {run.status}
                          </span>
                        </button>
                        {openRunId === run.id && (
                          <div className="mt-2 space-y-2">
                            {run.status === "failed" && (
                              <p className="text-xs text-spark-orange">
                                {run.error_detail ?? "Run failed"}
                              </p>
                            )}
                            {run.status === "succeeded" && (
                              <>
                                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-deep-ink/40 p-2 text-xs text-parchment/80">
                                  {run.output_md}
                                </pre>
                                <div className="flex flex-wrap gap-2">
                                  <Button size="sm" variant="secondary" onClick={() => void copyOutput(run)}>
                                    Copy
                                  </Button>
                                  <a
                                    href={`/api/dashboard/agents/runs/${run.id}/download?businessId=${encodeURIComponent(businessId)}`}
                                    className="inline-flex items-center rounded-md border border-parchment/20 px-3 py-1.5 text-xs text-parchment hover:bg-parchment/10 transition-colors"
                                  >
                                    Download {run.output_filename || "output"}
                                  </a>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => void saveRunAsDocument(run)}
                                    disabled={savingRunDoc === run.id}
                                  >
                                    {savingRunDoc === run.id ? "Saving…" : "Save to Documents"}
                                  </Button>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>

                {/* Edit panel */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-parchment/70 uppercase tracking-wide">
                    Edit
                  </p>
                  <div>
                    <label className={labelClass}>Name</label>
                    <input
                      className={inputClass}
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      maxLength={120}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Instructions</label>
                    <textarea
                      className={`${inputClass} min-h-28`}
                      value={draftInstructions}
                      onChange={(e) => setDraftInstructions(e.target.value)}
                      maxLength={8000}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Output format</label>
                    <select
                      className={inputClass}
                      value={draftFormat}
                      onChange={(e) => setDraftFormat(e.target.value as AgentItem["output_format"])}
                    >
                      <option value="markdown">Markdown (works for everything)</option>
                      <option value="same_as_input">Same as input (CSV in → CSV out)</option>
                    </select>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void saveAgent(agent)} disabled={savingAgent}>
                      {savingAgent ? "Saving…" : "Save changes"}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void toggleEnabled(agent)}>
                      {agent.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => void deleteAgent(agent)}>
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
