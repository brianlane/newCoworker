"use client";

/**
 * Tasks page "Data" view: an Airtable-style grid over the business's leads.
 *
 * Rows come from /api/dashboard/leads-data (lead_submissions folded onto
 * contacts); columns are fixed lead identity/stage fields plus DYNAMIC
 * columns from the submitted answers (whatever the tenant's form collects).
 * The Stage cell is an inline dropdown over the selected pipeline's stages,
 * it calls the same move endpoint as the board's drag-and-drop, so tag
 * automation (tag_changed flows, goal events, Meta CAPI feedback) fires
 * identically. Export downloads the visible rows as CSV.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Download, RefreshCw, Trash2, X } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import type { RosterOption } from "@/components/dashboard/LeadQuickEditor";
import { NewLeadButton } from "@/components/dashboard/NewLeadButton";
import { stageForTags } from "@/lib/pipelines/board";
import { computeStageMove } from "@/lib/pipelines/move";
import type { Pipeline } from "@/lib/pipelines/types";
import type { LeadDataRow } from "@/lib/leads/data-view";

type Scope = "mine" | "all";

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

/** "skin_concern" / "field_data.city" → "Skin concern" / "City". */
export function humanizeColumnKey(key: string): string {
  const last = key.split(".").filter((s) => !/^\d+$/.test(s)).pop() ?? key;
  const words = last.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words.length === 0 ? key : words[0].toUpperCase() + words.slice(1).toLowerCase();
}

/** RFC-4180-enough CSV escaping: quote when the value needs it. */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildLeadsCsv(
  rows: LeadDataRow[],
  dynamicColumns: string[],
  stageNameFor: (row: LeadDataRow) => string
): string {
  const header = [
    "Name",
    "Phone",
    "Email",
    "Stage",
    "Source",
    "Owner",
    "Added",
    ...dynamicColumns.map(humanizeColumnKey)
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.name,
        row.e164 ?? "",
        row.email ?? "",
        stageNameFor(row),
        row.source ?? "",
        row.ownerName ?? "",
        row.createdAt,
        ...dynamicColumns.map((c) => row.fields[c] ?? "")
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n");
}

export function LeadDataGrid({
  businessId,
  defaultScope,
  hasLinkedEmployee,
  canManage
}: {
  businessId: string;
  defaultScope: Scope;
  hasLinkedEmployee: boolean;
  /** Owner/manager: may create the starter pipeline from the empty state. */
  canManage: boolean;
}) {
  const t = useTranslations("dashboard.tasksData");
  const [scope, setScope] = useState<Scope>(defaultScope);
  const [rows, setRows] = useState<LeadDataRow[] | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [employees, setEmployees] = useState<RosterOption[]>([]);
  const [implicitOwnerEmployeeId, setImplicitOwnerEmployeeId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Move/owner/delete failures, shown in the dismissable strip. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(
    async (nextScope: Scope) => {
      setLoading(true);
      setError(null);
      try {
        const [pipelinesData, gridData] = await Promise.all([
          fetch(`/api/dashboard/pipelines?businessId=${encodeURIComponent(businessId)}`, {
            cache: "no-store"
          }).then((r) => readEnvelope<{ pipelines: Pipeline[] }>(r)),
          fetch(
            `/api/dashboard/leads-data?businessId=${encodeURIComponent(businessId)}&scope=${nextScope}`,
            { cache: "no-store" }
          ).then((r) =>
            readEnvelope<{
              rows: LeadDataRow[];
              columns: string[];
              employees: RosterOption[];
              implicitOwnerEmployeeId: string | null;
            }>(r)
          )
        ]);
        setPipelines(pipelinesData.pipelines);
        setSelectedId((prev) =>
          prev && pipelinesData.pipelines.some((p) => p.id === prev)
            ? prev
            : pipelinesData.pipelines[0]?.id ?? null
        );
        setRows(gridData.rows);
        setColumns(gridData.columns);
        setEmployees(gridData.employees ?? []);
        setImplicitOwnerEmployeeId(gridData.implicitOwnerEmployeeId ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : t("loadFailed"));
        setRows(null);
        setPipelines(null);
      } finally {
        setLoading(false);
      }
    },
    [businessId, t]
  );

  useEffect(() => {
    void load(scope);
  }, [load, scope]);

  const pipeline = useMemo(
    () => pipelines?.find((p) => p.id === selectedId) ?? null,
    [pipelines, selectedId]
  );

  const stageNameFor = useCallback(
    (row: LeadDataRow): string => {
      // Three distinct states, so the CSV stops exporting "No contact yet"
      // for every row of a business that simply has no board.
      if (!pipeline) return t("stageNoPipeline");
      if (!row.hasContact || !row.e164) return t("stageNoContact");
      return stageForTags(pipeline.stages, row.tags)?.name ?? "";
    },
    [pipeline, t]
  );

  const seedDefault = useCallback(async () => {
    setSeeding(true);
    setError(null);
    try {
      await fetch(`/api/dashboard/pipelines?businessId=${encodeURIComponent(businessId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seedDefault: true })
      }).then((r) => readEnvelope<{ pipeline: Pipeline }>(r));
      await load(scope);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("createPipelineFailed"));
    } finally {
      setSeeding(false);
    }
  }, [businessId, load, scope, t]);

  const moveLead = useCallback(
    async (row: LeadDataRow, stageId: string | null) => {
      if (!pipeline || !row.e164 || !row.hasContact) return;
      const target = stageId
        ? pipeline.stages.find((s) => s.id === stageId) ?? null
        : null;
      if (stageId && !target) return;
      setActionError(null);

      // Optimistic: apply the same tag delta the server will compute.
      const delta = computeStageMove(
        row.tags,
        pipeline.stages.map((s) => s.name),
        target?.name ?? null
      );
      if (delta.added.length === 0 && delta.removed.length === 0) return;
      const previous = rows;
      setRows((rs) =>
        rs ? rs.map((r) => (r === row ? { ...r, tags: delta.nextTags } : r)) : rs
      );

      try {
        const data = await fetch(
          `/api/dashboard/pipelines/${encodeURIComponent(pipeline.id)}/move?businessId=${encodeURIComponent(businessId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contactE164: row.e164, stageId })
          }
        ).then((r) => readEnvelope<{ tags: string[]; droppedAtCap: boolean }>(r));
        setRows((rs) =>
          rs
            ? rs.map((r) => (r.e164 === row.e164 ? { ...r, tags: data.tags } : r))
            : rs
        );
        if (data.droppedAtCap) {
          setActionError(t("tagCap", { name: row.name }));
        }
      } catch (e) {
        setRows(previous);
        setActionError(e instanceof Error ? e.message : t("moveFailed"));
      }
    },
    [businessId, pipeline, rows, t]
  );

  const changeOwner = useCallback(
    async (row: LeadDataRow, ownerEmployeeId: string | null) => {
      if (!row.e164 || !row.hasContact || ownerEmployeeId === row.ownerEmployeeId) {
        return;
      }
      setActionError(null);

      // Optimistic, reverted on failure (same pattern as the stage move).
      const nextName = ownerEmployeeId
        ? employees.find((m) => m.id === ownerEmployeeId)?.name ?? null
        : null;
      const previous = rows;
      setRows((rs) =>
        rs
          ? rs.map((r) =>
              r.e164 === row.e164 ? { ...r, ownerEmployeeId, ownerName: nextName } : r
            )
          : rs
      );

      try {
        const res = await fetch(
          `/api/dashboard/customers/${encodeURIComponent(row.e164)}?businessId=${encodeURIComponent(businessId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerEmployeeId })
          }
        );
        const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        if (!res.ok || !json?.ok) throw new Error(t("ownerUpdateFailed"));
      } catch (e) {
        setRows(previous);
        setActionError(e instanceof Error ? e.message : t("ownerUpdateFailed"));
      }
    },
    [businessId, employees, rows, t]
  );

  const deleteLead = useCallback(
    async (row: LeadDataRow) => {
      if (!row.e164 || !row.hasContact) return;
      if (!window.confirm(t("editDeleteConfirm", { name: row.name }))) return;
      setActionError(null);
      try {
        const res = await fetch(
          `/api/dashboard/customers/${encodeURIComponent(row.e164)}?businessId=${encodeURIComponent(businessId)}`,
          { method: "DELETE" }
        );
        const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        if (!res.ok || !json?.ok) throw new Error(t("editDeleteFailed"));
        // Reload rather than splice: the lead may legitimately stay visible
        // as a submission-only row (hasContact false) after the contact goes.
        await load(scope);
      } catch (e) {
        setActionError(e instanceof Error ? e.message : t("editDeleteFailed"));
      }
    },
    [businessId, load, scope, t]
  );

  const exportCsv = useCallback(() => {
    if (!rows) return;
    const csv = buildLeadsCsv(rows, columns, stageNameFor);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rows, columns, stageNameFor]);

  return (
    <div className="space-y-4">
      {/* Toolbar: pipeline tabs (stage column source), scope, refresh, export */}
      <div className="flex flex-wrap items-center gap-2">
        {/*
          These pills pick which pipeline's stages fill the Stage COLUMN.
          They are not a dataset picker, but they were read as one often
          enough that it prompted building the Tables section, so they now
          say what they do. A business with exactly one pipeline sees no
          pills at all: a single pill that cannot be deselected is pure
          noise, and is how most owners first met them.
        */}
        {pipelines && pipelines.length > 1 && (
          <span className="text-xs text-parchment/40">{t("stageColumnLabel")}</span>
        )}
        {(pipelines?.length ?? 0) > 1 &&
          pipelines?.map((p) => (
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
            {(["mine", "all"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  scope === s
                    ? "bg-signal-teal/15 text-signal-teal"
                    : "text-parchment/50 hover:text-parchment/80"
                }`}
              >
                {s === "mine" ? t("scopeMine") : t("scopeAll")}
              </button>
            ))}
          </div>
          <button
            onClick={() => void load(scope)}
            className="inline-flex items-center gap-1.5 rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/60 hover:text-parchment"
            aria-label={t("refresh")}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("refresh")}
          </button>
          <button
            onClick={exportCsv}
            disabled={!rows || rows.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/60 hover:text-parchment disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            {t("exportCsv")}
          </button>
          <NewLeadButton
            businessId={businessId}
            stages={pipeline?.stages ?? null}
            onCreated={() => void load(scope)}
          />
        </div>
      </div>

      {scope === "mine" && !hasLinkedEmployee && (
        <Card>
          <p className="text-sm text-parchment/60">{t("noLinkedEmployee")}</p>
        </Card>
      )}

      {actionError && (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-spark-orange">{actionError}</p>
            <button
              onClick={() => setActionError(null)}
              className="text-parchment/40 hover:text-parchment"
              aria-label={t("dismiss")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </Card>
      )}

      {error && (
        <Card>
          <p className="text-sm text-spark-orange">{error}</p>
        </Card>
      )}

      {/* The unlinked-roster notice above already explains an empty "mine". */}
      {!error &&
        rows &&
        rows.length === 0 &&
        !loading &&
        !(scope === "mine" && !hasLinkedEmployee) && (
          <Card>
            <p className="py-6 text-center text-sm text-parchment/50">{t("empty")}</p>
          </Card>
        )}

      {/*
        A business with NO pipeline at all used to render "No contact yet" in
        every Stage cell, which reads as a data problem rather than a setup
        step. The Board view has always had a proper empty state; this is its
        counterpart, so the Stage column becomes usable from here too.
      */}
      {!error && pipelines !== null && pipelines.length === 0 && (
        <Card>
          <div className="space-y-3 py-4 text-center">
            <p className="text-sm text-parchment/70">{t("noPipelineTitle")}</p>
            <p className="text-sm text-parchment/60">{t("noPipelineBody")}</p>
            {canManage ? (
              <button
                onClick={() => void seedDefault()}
                disabled={seeding}
                className="inline-flex items-center gap-1.5 rounded-lg bg-claw-green px-4 py-2 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90 disabled:opacity-50"
              >
                {t("createPipeline")}
              </button>
            ) : (
              <p className="text-xs text-parchment/40">{t("noPipelineAskManager")}</p>
            )}
          </div>
        </Card>
      )}

      {!error && rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-parchment/10">
          <table className="w-full min-w-max text-left text-sm">
            <thead>
              <tr className="border-b border-parchment/10 bg-parchment/5 text-xs uppercase tracking-wide text-parchment/40">
                <th className="px-3 py-2 font-medium">{t("colName")}</th>
                <th className="px-3 py-2 font-medium">{t("colPhone")}</th>
                <th className="px-3 py-2 font-medium">{t("colEmail")}</th>
                <th className="px-3 py-2 font-medium">{t("colStage")}</th>
                <th className="px-3 py-2 font-medium">{t("colSource")}</th>
                <th className="px-3 py-2 font-medium">{t("colOwner")}</th>
                <th className="px-3 py-2 font-medium">{t("colAdded")}</th>
                {columns.map((c) => (
                  <th key={c} className="px-3 py-2 font-medium">
                    {humanizeColumnKey(c)}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">{t("colActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={row.e164 ?? `${row.email ?? "lead"}-${i}`}
                  className="border-b border-parchment/5 last:border-b-0 hover:bg-parchment/5"
                >
                  <td className="px-3 py-2 font-medium text-parchment">
                    {row.e164 && row.hasContact ? (
                      <a
                        href={`/dashboard/customers/${encodeURIComponent(row.e164)}`}
                        className="hover:text-signal-teal"
                      >
                        {row.name}
                      </a>
                    ) : (
                      row.name
                    )}
                  </td>
                  <td className="px-3 py-2 text-parchment/70">{row.e164 ?? "-"}</td>
                  <td className="px-3 py-2 text-parchment/70">{row.email ?? "-"}</td>
                  <td className="px-3 py-2">
                    {!pipeline ? (
                      <span className="text-parchment/40">{t("stageNoPipeline")}</span>
                    ) : row.hasContact && row.e164 ? (
                      <select
                        value={
                          stageForTags(pipeline.stages, row.tags)?.id ?? ""
                        }
                        onChange={(e) => void moveLead(row, e.target.value || null)}
                        className="rounded-md border border-parchment/15 bg-deep-ink px-2 py-1 text-xs text-parchment"
                        aria-label={t("colStage")}
                      >
                        <option value="">{t("stageNone")}</option>
                        {pipeline.stages.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-parchment/40">
                        {t("stageNoContact")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-parchment/70">{row.source ?? "-"}</td>
                  <td className="px-3 py-2">
                    {row.hasContact && row.e164 ? (
                      <select
                        value={row.ownerEmployeeId ?? ""}
                        onChange={(e) => void changeOwner(row, e.target.value || null)}
                        className="rounded-md border border-parchment/15 bg-deep-ink px-2 py-1 text-xs text-parchment"
                        aria-label={t("colOwner")}
                      >
                        {implicitOwnerEmployeeId === null && (
                          <option value="">{t("editUnassigned")}</option>
                        )}
                        {employees.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-parchment/70">{row.ownerName ?? "-"}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-parchment/50">
                    <LocalDateTime iso={row.createdAt} />
                  </td>
                  {columns.map((c) => (
                    <td key={c} className="max-w-56 truncate px-3 py-2 text-parchment/70">
                      {row.fields[c] ?? "-"}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right">
                    {row.hasContact && row.e164 && (
                      <button
                        type="button"
                        data-testid="grid-delete-lead"
                        onClick={() => void deleteLead(row)}
                        className="text-parchment/30 hover:text-spark-orange"
                        aria-label={t("editDelete")}
                        title={t("editDelete")}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Where the OTHER datasets live, including the ones the owner made. */}
      {!error && rows && rows.length > 0 && (
        <p className="text-xs text-parchment/35">
          {t("tablesPointer")}{" "}
          <Link href="/dashboard/tables" className="text-signal-teal/70 hover:text-signal-teal">
            {t("tablesPointerLink")}
          </Link>
        </p>
      )}

      {loading && !rows && (
        <Card>
          <p className="py-6 text-center text-sm text-parchment/50">{t("loading")}</p>
        </Card>
      )}
    </div>
  );
}
