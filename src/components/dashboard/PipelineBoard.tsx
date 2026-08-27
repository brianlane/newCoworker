"use client";

/**
 * GoHighLevel-style pipeline board (/dashboard/tasks, Board view).
 *
 * Columns are the ordered stages of an owner-defined pipeline; each stage
 * is BACKED BY A CONTACT TAG, so the board is a live view over
 * contacts.tags: AiFlow update_contact steps move cards automatically, and
 * dragging a card calls the move endpoint, which swaps the stage tags and
 * fires the same tag automation (tag_changed triggers, goal events) as any
 * other tag edit.
 *
 * Lead cards come from /api/dashboard/tasks (same data as the List view);
 * pipelines/stages from /api/dashboard/pipelines. Managers can edit the
 * board inline (create pipelines, add/rename/recolor/reorder/delete stages,
 * seed the default "Leads" board).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Pencil,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  User,
  X
} from "lucide-react";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import {
  LeadQuickEditor,
  type RosterOption
} from "@/components/dashboard/LeadQuickEditor";
import { NewLeadButton } from "@/components/dashboard/NewLeadButton";
import { groupCardsByStage, isStageTag } from "@/lib/pipelines/board";
import { computeStageMove } from "@/lib/pipelines/move";
import {
  STAGE_COLORS,
  type Pipeline,
  type PipelineStage,
  type StageColor
} from "@/lib/pipelines/types";
import type { TaskCardData } from "@/app/api/dashboard/tasks/route";

type Scope = "mine" | "all" | "unowned";

/** Column accents per palette color (dot + top border + background fill). */
const COLOR_CLASSES: Record<StageColor, { dot: string; border: string; bg: string }> = {
  teal: { dot: "bg-teal-400", border: "border-t-teal-400/60", bg: "bg-teal-400/10" },
  green: { dot: "bg-green-400", border: "border-t-green-400/60", bg: "bg-green-400/10" },
  orange: { dot: "bg-orange-400", border: "border-t-orange-400/60", bg: "bg-orange-400/10" },
  rose: { dot: "bg-rose-400", border: "border-t-rose-400/60", bg: "bg-rose-400/10" },
  violet: { dot: "bg-violet-400", border: "border-t-violet-400/60", bg: "bg-violet-400/10" },
  sky: { dot: "bg-sky-400", border: "border-t-sky-400/60", bg: "bg-sky-400/10" },
  amber: { dot: "bg-amber-400", border: "border-t-amber-400/60", bg: "bg-amber-400/10" },
  slate: { dot: "bg-slate-400", border: "border-t-slate-400/60", bg: "bg-slate-400/10" }
};

const RUN_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Needs approval",
  awaiting_agent: "Offered to team",
  awaiting_reply: "Awaiting reply",
  awaiting_call: "AI call in progress"
};

type ApiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { message?: string };
};

async function readEnvelope<T>(res: Response): Promise<T> {
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.ok || !json.data) {
    throw new Error(json.error?.message ?? "Request failed");
  }
  return json.data;
}

export function PipelineBoard({
  businessId,
  defaultScope,
  hasLinkedEmployee,
  canManage,
  highlightLead
}: {
  businessId: string;
  defaultScope: Scope;
  hasLinkedEmployee: boolean;
  canManage: boolean;
  highlightLead: string | null;
}) {
  const t = useTranslations("dashboard.tasksData");
  const tClaim = useTranslations("dashboard.leadClaim");
  const [scope, setScope] = useState<Scope>(defaultScope);
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskCardData[] | null>(null);
  const [employees, setEmployees] = useState<RosterOption[]>([]);
  const [implicitOwnerEmployeeId, setImplicitOwnerEmployeeId] = useState<string | null>(null);
  /** The roster member this login IS; null hides every Claim button. */
  const [myEmployeeId, setMyEmployeeId] = useState<string | null>(null);
  /** The card key mid-claim ("Claiming…" on exactly that button). */
  const [claimingKey, setClaimingKey] = useState<string | null>(null);
  /** Claim outcome worth telling: lost race ("already claimed by…"), failure. */
  const [claimNotice, setClaimNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  /** The lead whose quick editor is open in the modal (a contact key). */
  const [editLeadKey, setEditLeadKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const highlightRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(
    async (nextScope: Scope) => {
      setLoading(true);
      setError(null);
      try {
        const [pipelinesData, tasksData] = await Promise.all([
          fetch(`/api/dashboard/pipelines?businessId=${encodeURIComponent(businessId)}`, {
            cache: "no-store"
          }).then((r) => readEnvelope<{ pipelines: Pipeline[] }>(r)),
          fetch(
            `/api/dashboard/tasks?businessId=${encodeURIComponent(businessId)}&scope=${nextScope}`,
            { cache: "no-store" }
          ).then((r) =>
            readEnvelope<{
              tasks: TaskCardData[];
              employees: RosterOption[];
              myEmployeeId: string | null;
              implicitOwnerEmployeeId: string | null;
            }>(r)
          )
        ]);
        setPipelines(pipelinesData.pipelines);
        setTasks(tasksData.tasks);
        setEmployees(tasksData.employees ?? []);
        setMyEmployeeId(tasksData.myEmployeeId ?? null);
        setImplicitOwnerEmployeeId(tasksData.implicitOwnerEmployeeId ?? null);
        setSelectedId((prev) =>
          prev && pipelinesData.pipelines.some((p) => p.id === prev)
            ? prev
            : pipelinesData.pipelines[0]?.id ?? null
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't load the board");
        setPipelines(null);
        setTasks(null);
      } finally {
        setLoading(false);
      }
    },
    [businessId]
  );

  useEffect(() => {
    void load(scope);
  }, [load, scope]);

  // Scroll the ?lead= deep-linked card into view once it renders.
  useEffect(() => {
    if (highlightLead && highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: "center", inline: "center" });
    }
  }, [highlightLead, tasks, selectedId]);

  const pipeline = useMemo(
    () => pipelines?.find((p) => p.id === selectedId) ?? null,
    [pipelines, selectedId]
  );

  const columns = useMemo(() => {
    if (!pipeline || !tasks) return new Map<string, TaskCardData[]>();
    return groupCardsByStage(pipeline.stages, tasks);
  }, [pipeline, tasks]);

  /** The task card behind the open quick-edit modal, fresh across reloads. */
  const editLead = useMemo(
    () =>
      editLeadKey && tasks
        ? tasks.find((c) => c.e164 === editLeadKey) ?? null
        : null,
    [editLeadKey, tasks]
  );

  /** Leads with tags/runs that match NO stage of the selected pipeline. */
  const offBoardCount = useMemo(() => {
    if (!pipeline || !tasks) return 0;
    const onBoard = new Set(
      [...columns.values()].flat().map((t) => t.e164)
    );
    return tasks.filter((t) => !onBoard.has(t.e164)).length;
  }, [pipeline, tasks, columns]);

  const moveCard = useCallback(
    async (e164: string, stageId: string) => {
      if (!pipeline || !tasks) return;
      const card = tasks.find((t) => t.e164 === e164);
      const target = pipeline.stages.find((s) => s.id === stageId);
      if (!card || !target) return;
      setMoveError(null);

      // Optimistic: apply the same tag delta the server will compute.
      const delta = computeStageMove(
        card.tags,
        pipeline.stages.map((s) => s.name),
        target.name
      );
      if (delta.added.length === 0 && delta.removed.length === 0) return;
      const previous = tasks;
      setTasks(tasks.map((t) => (t.e164 === e164 ? { ...t, tags: delta.nextTags } : t)));

      try {
        const data = await fetch(
          `/api/dashboard/pipelines/${encodeURIComponent(pipeline.id)}/move?businessId=${encodeURIComponent(businessId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contactE164: e164, stageId })
          }
        ).then((r) => readEnvelope<{ tags: string[]; droppedAtCap: boolean }>(r));
        // Sync to the authoritative tag set (alias canonicalization etc.).
        setTasks((ts) =>
          ts ? ts.map((t) => (t.e164 === e164 ? { ...t, tags: data.tags } : t)) : ts
        );
        if (data.droppedAtCap) {
          setMoveError(
            `${card.name} is at the 25-tag limit, so the "${target.name}" tag couldn't be added.`
          );
        }
      } catch (e) {
        setTasks(previous);
        setMoveError(
          e instanceof Error ? e.message : "Couldn't move the lead, try again."
        );
      }
    },
    [businessId, pipeline, tasks]
  );

  /**
   * Claim an unowned lead for the signed-in teammate. The server performs
   * the race-safe null-owner compare-and-swap; a 409 means somebody got
   * there first, so the notice names them and the reload shows the fresh
   * owner instead of a stale Claim button.
   */
  const claimLead = useCallback(
    async (contactKey: string) => {
      setClaimingKey(contactKey);
      setClaimNotice(null);
      try {
        const res = await fetch(`/api/dashboard/leads/claim`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ businessId, contactKey })
        });
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          error?: { message?: string; ownerName?: string | null };
        } | null;
        if (res.status === 409) {
          const name = json?.error?.ownerName;
          setClaimNotice(
            name ? tClaim("alreadyClaimed", { name }) : tClaim("alreadyClaimedUnknown")
          );
          await load(scope);
          return;
        }
        if (!res.ok || !json?.ok) {
          setClaimNotice(json?.error?.message ?? tClaim("claimFailed"));
          return;
        }
        await load(scope);
      } catch {
        setClaimNotice(tClaim("claimFailed"));
      } finally {
        setClaimingKey(null);
      }
    },
    [businessId, load, scope, tClaim]
  );

  const toggleCollapsed = (stageId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(stageId)) next.delete(stageId);
      else next.add(stageId);
      return next;
    });
  };

  const seedDefault = async () => {
    setBusy(true);
    setError(null);
    try {
      await fetch(`/api/dashboard/pipelines?businessId=${encodeURIComponent(businessId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seedDefault: true })
      }).then((r) => readEnvelope<{ pipeline: Pipeline }>(r));
      await load(scope);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the pipeline");
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Card>
        <p className="text-sm text-spark-orange">{error}</p>
      </Card>
    );
  }

  if (pipelines !== null && pipelines.length === 0) {
    return (
      <Card>
        <div className="space-y-3 py-4 text-center">
          <p className="text-sm text-parchment/60">
            No pipeline yet. A pipeline turns your lead tags into a drag-and-drop
            board, each column is a stage backed by a tag, so your AiFlows move
            leads across it automatically.
          </p>
          {canManage ? (
            <button
              onClick={() => void seedDefault()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-claw-green px-4 py-2 text-sm font-semibold text-deep-ink transition-colors hover:bg-claw-green/90 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              Create the default lead pipeline
            </button>
          ) : (
            <p className="text-xs text-parchment/40">
              Ask a manager to create one from this page.
            </p>
          )}
          <p className="text-xs text-parchment/40">
            Default stages: New Lead → Contacted → Engaged → Booked → Won
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar: pipeline tabs, scope, refresh, manage */}
      <div className="flex flex-wrap items-center gap-2">
        {pipelines?.map((p) => (
          <button
            key={p.id}
            onClick={() => setSelectedId(p.id)}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
              p.id === selectedId
                ? "border-signal-teal/60 bg-signal-teal/15 text-signal-teal"
                : "border-parchment/15 text-parchment/50 hover:text-parchment/80"
            }`}
          >
            {p.name}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-parchment/15">
            {(["mine", "all", "unowned"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  scope === s
                    ? "bg-signal-teal/15 text-signal-teal"
                    : "text-parchment/50 hover:text-parchment/80"
                }`}
              >
                {s === "mine" ? "My leads" : s === "all" ? "All leads" : tClaim("scopeUnowned")}
              </button>
            ))}
          </div>
          <button
            onClick={() => void load(scope)}
            className="inline-flex items-center gap-1.5 rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/60 hover:text-parchment"
            aria-label="Refresh board"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <NewLeadButton
            businessId={businessId}
            stages={pipeline?.stages ?? null}
            onCreated={() => void load(scope)}
          />
          {canManage && (
            <button
              onClick={() => setEditing((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                editing
                  ? "border-signal-teal/60 bg-signal-teal/15 text-signal-teal"
                  : "border-parchment/15 text-parchment/60 hover:text-parchment"
              }`}
            >
              <Pencil className="h-3.5 w-3.5" />
              Manage board
            </button>
          )}
        </div>
      </div>

      {scope === "mine" && !hasLinkedEmployee && (
        <Card>
          <p className="text-sm text-parchment/60">
            Your login isn&apos;t linked to a team-roster member yet, so there are no
            &quot;my&quot; leads to show. Ask a manager to link your login to your roster
            profile (Settings → Team access), or switch to All leads.
          </p>
        </Card>
      )}

      {moveError && (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-spark-orange">{moveError}</p>
            <button
              onClick={() => setMoveError(null)}
              className="text-parchment/40 hover:text-parchment"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </Card>
      )}

      {claimNotice && (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <p data-testid="claim-notice" className="text-sm text-spark-orange">
              {claimNotice}
            </p>
            <button
              onClick={() => setClaimNotice(null)}
              className="text-parchment/40 hover:text-parchment"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </Card>
      )}

      {canManage && editing && pipeline && (
        <PipelineEditor
          businessId={businessId}
          pipeline={pipeline}
          onChanged={() => void load(scope)}
        />
      )}

      {/* The board. The scroll strip carries the sidebar's panel treatment
          (same bg/border as the Sign out button) so the columns read as one
          surface instead of floating on the page background. */}
      {pipeline && (
        <div className="flex items-start gap-3 overflow-x-auto rounded-lg border border-parchment/10 bg-parchment/5 p-3">
          {pipeline.stages.map((stage) => {
            const cards = columns.get(stage.id) ?? [];
            const colors = COLOR_CLASSES[stage.color];
            const isCollapsed = collapsed.has(stage.id);
            return (
              <div
                key={stage.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverStage(stage.id);
                }}
                onDragLeave={() => setDragOverStage((s) => (s === stage.id ? null : s))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverStage(null);
                  const e164 = e.dataTransfer.getData("text/plain");
                  if (e164) void moveCard(e164, stage.id);
                }}
                // The stage color fills the whole column; the drop cue is a
                // ring so it never fights the color fill.
                className={`rounded-lg border border-t-2 transition-colors ${colors.border} ${colors.bg} ${
                  dragOverStage === stage.id
                    ? "border-signal-teal/60 ring-1 ring-signal-teal/40"
                    : "border-parchment/10"
                } ${isCollapsed ? "w-12 shrink-0" : "w-72 shrink-0"}`}
              >
                <div
                  className={`flex items-center gap-2 px-3 py-2.5 ${
                    isCollapsed ? "flex-col px-0" : ""
                  }`}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${colors.dot}`} />
                  {!isCollapsed && (
                    <span className="truncate text-xs font-semibold text-parchment/80">
                      {stage.name}
                    </span>
                  )}
                  <span className="rounded-full bg-parchment/10 px-1.5 py-0.5 text-[10px] text-parchment/50">
                    {cards.length}
                  </span>
                  <button
                    onClick={() => toggleCollapsed(stage.id)}
                    className={`text-parchment/40 hover:text-parchment ${isCollapsed ? "" : "ml-auto"}`}
                    aria-label={isCollapsed ? "Expand stage" : "Collapse stage"}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronLeft className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                {!isCollapsed && (
                  <div className="space-y-2 px-2 pb-2">
                    {cards.length === 0 && (
                      <p className="px-1 py-3 text-center text-[11px] text-parchment/30">
                        Drop a lead here
                      </p>
                    )}
                    {cards.map((card) => (
                      <BoardCard
                        key={card.e164}
                        card={card}
                        stages={pipeline.stages}
                        highlighted={card.e164 === highlightLead}
                        highlightRef={card.e164 === highlightLead ? highlightRef : null}
                        onEdit={() => setEditLeadKey(card.e164)}
                        // Claimable in every scope that can SHOW an unowned
                        // card ("Unowned" and "All leads"): unowned, a real
                        // contact row to write, and a caller with a roster
                        // identity to claim it for.
                        claimable={
                          card.ownerEmployeeId === null &&
                          card.hasContact &&
                          myEmployeeId !== null
                        }
                        claiming={claimingKey === card.e164}
                        onClaim={() => void claimLead(card.e164)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {pipeline && offBoardCount > 0 && (
        <p className="text-xs text-parchment/40">
          {offBoardCount} lead{offBoardCount === 1 ? "" : "s"} in motion{" "}
          {offBoardCount === 1 ? "isn't" : "aren't"} on this pipeline (no matching
          stage tag), see the List view for everything.
        </p>
      )}

      {editLead && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setEditLeadKey(null)}
          role="dialog"
          aria-modal="true"
          aria-label={t("editLead")}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-parchment/15 bg-deep-ink p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-parchment">{editLead.name}</h3>
              <button
                onClick={() => setEditLeadKey(null)}
                className="text-parchment/40 hover:text-parchment"
                aria-label={t("editCancel")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <LeadQuickEditor
              businessId={businessId}
              contactKey={editLead.e164}
              resolvedName={editLead.name}
              initialDisplayName={editLead.displayName}
              initialTags={editLead.tags}
              initialOwnerEmployeeId={editLead.ownerEmployeeId}
              employees={employees}
              implicitOwnerEmployeeId={implicitOwnerEmployeeId}
              hasActiveRuns={editLead.runs.length > 0}
              onSaved={() => {
                setEditLeadKey(null);
                void load(scope);
              }}
              onDeleted={() => {
                setEditLeadKey(null);
                void load(scope);
              }}
              onClose={() => setEditLeadKey(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function BoardCard({
  card,
  stages,
  highlighted,
  highlightRef,
  onEdit,
  claimable,
  claiming,
  onClaim
}: {
  card: TaskCardData;
  stages: PipelineStage[];
  highlighted: boolean;
  highlightRef: React.RefObject<HTMLDivElement | null> | null;
  onEdit: () => void;
  /** Unowned + claimable by this viewer: the owner slot becomes a Claim button. */
  claimable: boolean;
  claiming: boolean;
  onClaim: () => void;
}) {
  const t = useTranslations("dashboard.tasksData");
  const tClaim = useTranslations("dashboard.leadClaim");
  const activeRun = card.runs[0] ?? null;
  const extraTags = card.tags.filter((tag) => !isStageTag(stages, tag));
  return (
    <div
      ref={highlightRef}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", card.e164);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={`cursor-grab rounded-md border bg-deep-ink/60 p-2.5 active:cursor-grabbing ${
        highlighted
          ? "border-signal-teal ring-1 ring-signal-teal/60"
          : "border-parchment/10 hover:border-parchment/25"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Link
          href={`/dashboard/customers/${encodeURIComponent(card.e164)}`}
          title={card.name}
          className="truncate text-sm font-semibold text-parchment hover:text-signal-teal hover:underline"
        >
          {card.name}
        </Link>
        {card.hasContact && (
          <button
            type="button"
            data-testid="board-card-edit"
            onClick={onEdit}
            className="ml-auto shrink-0 text-parchment/30 hover:text-signal-teal"
            aria-label={t("editLead")}
            title={t("editLead")}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      <p className="mt-0.5 text-[10px] font-mono text-parchment/40">{card.e164}</p>
      {activeRun && (
        <p className="mt-1 truncate text-[11px] text-parchment/60" title={activeRun.flowName}>
          <span className="rounded bg-signal-teal/10 px-1 py-0.5 text-[10px] font-medium text-signal-teal">
            {RUN_STATUS_LABEL[activeRun.status] ?? activeRun.status}
          </span>{" "}
          {activeRun.flowName}
        </p>
      )}
      {extraTags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {extraTags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-0.5 rounded-full bg-parchment/10 px-1.5 py-0.5 text-[10px] text-parchment/60"
            >
              <Tag className="h-2.5 w-2.5" />
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-parchment/40">
        {claimable ? (
          <button
            type="button"
            data-testid="board-card-claim"
            // The card is draggable; a click meant for the button must not
            // start a drag-and-drop or bubble into the card's handlers.
            onClick={(e) => {
              e.stopPropagation();
              onClaim();
            }}
            disabled={claiming}
            className="rounded bg-claw-green px-2 py-0.5 text-[10px] font-semibold text-deep-ink transition-colors hover:bg-claw-green/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {claiming ? tClaim("claiming") : tClaim("claim")}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1 truncate">
            <User className="h-3 w-3" />
            {card.ownerName ?? "unassigned"}
          </span>
        )}
        <LocalDateTime iso={card.lastActivityAt} />
      </div>
    </div>
  );
}

/**
 * Inline board administration (manager+): rename the pipeline, add/rename/
 * recolor/reorder/delete stages, create another pipeline, delete this one.
 * Every action round-trips the API, then asks the parent to reload.
 */
function PipelineEditor({
  businessId,
  pipeline,
  onChanged
}: {
  businessId: string;
  pipeline: Pipeline;
  onChanged: () => void;
}) {
  const [name, setName] = useState(pipeline.name);
  const [newStage, setNewStage] = useState("");
  const [newStageColor, setNewStageColor] = useState<StageColor>("teal");
  const [newPipeline, setNewPipeline] = useState("");
  const [stageNames, setStageNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset drafts when the selected pipeline changes.
  useEffect(() => {
    setName(pipeline.name);
    setStageNames({});
    setError(null);
  }, [pipeline.id, pipeline.name]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fetch(
        `/api/dashboard/pipelines/${encodeURIComponent(pipeline.id)}?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }
      ).then((r) => readEnvelope<unknown>(r));
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That change didn't save");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reorder = (stageId: string, direction: -1 | 1) => {
    const ids = pipeline.stages.map((s) => s.id);
    const idx = ids.indexOf(stageId);
    const swap = idx + direction;
    if (swap < 0 || swap >= ids.length) return;
    [ids[idx], ids[swap]] = [ids[swap]!, ids[idx]!];
    void patch({ action: "reorder_stages", stageIds: ids });
  };

  const deleteStage = (stage: PipelineStage) => {
    const others = pipeline.stages.filter((s) => s.id !== stage.id);
    let destinationStageId: string | undefined;
    if (others.length > 0) {
      const move = window.confirm(
        `Delete stage "${stage.name}". Move its leads to "${others[0]!.name}"?\n\nOK = move them · Cancel = leave their tags as-is`
      );
      if (move) destinationStageId = others[0]!.id;
    }
    void patch({ action: "delete_stage", stageId: stage.id, ...(destinationStageId ? { destinationStageId } : {}) });
  };

  const createPipeline = async () => {
    const trimmed = newPipeline.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await fetch(`/api/dashboard/pipelines?businessId=${encodeURIComponent(businessId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          stages: [{ name: "New", color: "sky" }]
        })
      }).then((r) => readEnvelope<unknown>(r));
      setNewPipeline("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the pipeline");
    } finally {
      setBusy(false);
    }
  };

  const deletePipeline = async () => {
    if (
      !window.confirm(
        `Delete the "${pipeline.name}" pipeline? Leads keep their tags, only the board view goes away.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await fetch(
        `/api/dashboard/pipelines/${encodeURIComponent(pipeline.id)}?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE", headers: { "Content-Type": "application/json" } }
      ).then((r) => readEnvelope<unknown>(r));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete the pipeline");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4">
      {error && <p className="text-sm text-spark-orange">{error}</p>}

      {/* Pipeline name */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-parchment/60" htmlFor="pipeline-name">
          Pipeline
        </label>
        <input
          id="pipeline-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-sm text-parchment"
          maxLength={80}
        />
        <button
          onClick={() => void patch({ action: "rename", name })}
          disabled={busy || name.trim() === pipeline.name || !name.trim()}
          className="rounded-md border border-parchment/15 px-2.5 py-1 text-xs text-parchment/70 hover:text-parchment disabled:opacity-40"
        >
          Rename
        </button>
        <button
          onClick={() => void deletePipeline()}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-spark-orange/40 px-2.5 py-1 text-xs text-spark-orange hover:bg-spark-orange/10 disabled:opacity-40"
        >
          <Trash2 className="h-3 w-3" />
          Delete pipeline
        </button>
      </div>

      {/* Stages */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-parchment/60">
          Stages (each stage is a contact tag, renaming a stage re-tags its leads)
        </p>
        {pipeline.stages.map((stage, i) => {
          const draft = stageNames[stage.id] ?? stage.name;
          return (
            <div key={stage.id} className="flex flex-wrap items-center gap-1.5">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${COLOR_CLASSES[stage.color].dot}`}
              />
              <input
                value={draft}
                onChange={(e) =>
                  setStageNames((prev) => ({ ...prev, [stage.id]: e.target.value }))
                }
                className="w-40 rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-xs text-parchment"
                maxLength={40}
              />
              <button
                onClick={() =>
                  void patch({ action: "update_stage", stageId: stage.id, name: draft })
                }
                disabled={busy || draft.trim() === stage.name || !draft.trim()}
                className="rounded-md border border-parchment/15 px-2 py-1 text-[11px] text-parchment/70 hover:text-parchment disabled:opacity-40"
              >
                Save
              </button>
              <select
                value={stage.color}
                onChange={(e) =>
                  void patch({
                    action: "update_stage",
                    stageId: stage.id,
                    color: e.target.value
                  })
                }
                disabled={busy}
                className="rounded-md border border-parchment/15 bg-deep-ink/40 px-1.5 py-1 text-[11px] text-parchment/70"
                aria-label={`Color of ${stage.name}`}
              >
                {STAGE_COLORS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <button
                onClick={() => reorder(stage.id, -1)}
                disabled={busy || i === 0}
                className="text-parchment/40 hover:text-parchment disabled:opacity-30"
                aria-label={`Move ${stage.name} left`}
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => reorder(stage.id, 1)}
                disabled={busy || i === pipeline.stages.length - 1}
                className="text-parchment/40 hover:text-parchment disabled:opacity-30"
                aria-label={`Move ${stage.name} right`}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => deleteStage(stage)}
                disabled={busy}
                className="text-spark-orange/70 hover:text-spark-orange disabled:opacity-30"
                aria-label={`Delete ${stage.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <input
            value={newStage}
            onChange={(e) => setNewStage(e.target.value)}
            placeholder="New stage (tag) name…"
            className="w-40 rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-xs text-parchment placeholder:text-parchment/30"
            maxLength={40}
          />
          <select
            value={newStageColor}
            onChange={(e) => setNewStageColor(e.target.value as StageColor)}
            className="rounded-md border border-parchment/15 bg-deep-ink/40 px-1.5 py-1 text-[11px] text-parchment/70"
            aria-label="New stage color"
          >
            {STAGE_COLORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            onClick={async () => {
              const ok = await patch({
                action: "add_stage",
                stage: { name: newStage.trim(), color: newStageColor }
              });
              if (ok) setNewStage("");
            }}
            disabled={busy || !newStage.trim()}
            className="inline-flex items-center gap-1 rounded-md border border-parchment/15 px-2.5 py-1 text-xs text-parchment/70 hover:text-parchment disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
            Add stage
          </button>
        </div>
      </div>

      {/* New pipeline */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-parchment/10 pt-3">
        <input
          value={newPipeline}
          onChange={(e) => setNewPipeline(e.target.value)}
          placeholder="New pipeline name…"
          className="w-48 rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-xs text-parchment placeholder:text-parchment/30"
          maxLength={80}
        />
        <button
          onClick={() => void createPipeline()}
          disabled={busy || !newPipeline.trim()}
          className="inline-flex items-center gap-1 rounded-md border border-parchment/15 px-2.5 py-1 text-xs text-parchment/70 hover:text-parchment disabled:opacity-40"
        >
          <Plus className="h-3 w-3" />
          Create pipeline
        </button>
        <span className="text-[11px] text-parchment/40">
          starts with one &quot;New&quot; stage, add more above after selecting it
        </span>
      </div>
    </Card>
  );
}
