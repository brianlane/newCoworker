"use client";

/**
 * One custom table: toolbar, grid, and the two panels (Columns, Recent
 * changes) that replace the toolbar when open.
 *
 * Cell saves are optimistic with a revert on failure, and the client
 * validates first using the SAME pure core the server uses
 * (src/lib/custom-tables/core.ts imports nothing server-only), so a bad cell
 * is refused before a round trip and the message is identical either way.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Columns3, History, Plus, RefreshCw, Search, X } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { CustomTableGrid } from "@/components/dashboard/CustomTableGrid";
import { CustomTableHistory } from "@/components/dashboard/CustomTableHistory";
import { TableColumnsEditor } from "@/components/dashboard/TableColumnsEditor";
import { TableRowDrawer } from "@/components/dashboard/TableRowDrawer";
import {
  coerceFieldValue,
  describeRowErrors,
  validateRowValues
} from "@/lib/custom-tables/core";
import type { CustomTableHistoryEntry } from "@/lib/custom-tables/version-history";
import type {
  CustomTable,
  CustomTableFieldValue,
  CustomTableRowWithContact
} from "@/lib/custom-tables/types";

type Props = {
  businessId: string;
  table: CustomTable;
  canManage: boolean;
  justCreated: boolean;
  openColumns: boolean;
  openRowId: string | null;
};

type ApiEnvelope<T> = { ok: boolean; data?: T; error?: { message?: string } };

async function readEnvelope<T>(res: Response): Promise<T> {
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.ok || !json.data) {
    throw new Error(json.error?.message ?? "Request failed");
  }
  return json.data;
}

type Panel = "none" | "columns" | "history";

export function CustomTableWorkspace({
  businessId,
  table: initialTable,
  canManage,
  justCreated,
  openColumns,
  openRowId
}: Props) {
  const t = useTranslations("dashboard.tables");
  const router = useRouter();
  const [table, setTable] = useState(initialTable);
  const [rows, setRows] = useState<CustomTableRowWithContact[] | null>(null);
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<Panel>(openColumns ? "columns" : "none");
  const [history, setHistory] = useState<CustomTableHistoryEntry[] | null>(null);
  const [drawerRowId, setDrawerRowId] = useState<string | null>(openRowId);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const suffix = `businessId=${encodeURIComponent(businessId)}`;
  const base = `/api/dashboard/custom-tables/${encodeURIComponent(table.id)}`;

  const load = useCallback(
    async (search: string) => {
      setLoading(true);
      try {
        const params = search.trim() ? `&q=${encodeURIComponent(search.trim())}` : "";
        const data = await fetch(`${base}/rows?${suffix}${params}`, { cache: "no-store" }).then(
          (r) => readEnvelope<{ table: CustomTable; rows: CustomTableRowWithContact[] }>(r)
        );
        setTable(data.table);
        setRows(data.rows);
      } catch (e) {
        setError(e instanceof Error ? e.message : t("loadFailed"));
        setRows(null);
      } finally {
        setLoading(false);
      }
    },
    [base, suffix, t]
  );

  useEffect(() => {
    void load(query);
    // Deliberately not keyed on `query`: the search box filters on submit,
    // not on every keystroke, so typing does not fire a request per letter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const loadHistory = useCallback(async () => {
    setHistory(null);
    try {
      const data = await fetch(`${base}/versions?${suffix}`, { cache: "no-store" }).then((r) =>
        readEnvelope<{ entries: CustomTableHistoryEntry[] }>(r)
      );
      setHistory(data.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("loadFailed"));
      setHistory([]);
    }
  }, [base, suffix, t]);

  const openPanel = (next: Panel) => {
    setPanel((prev) => {
      const value = prev === next ? "none" : next;
      if (value === "history") void loadHistory();
      return value;
    });
  };

  /** Optimistic per-cell save, reverting the row on failure. */
  const saveCell = async (rowId: string, fieldId: string, raw: CustomTableFieldValue | null) => {
    const field = table.fields.find((f) => f.id === fieldId);
    if (!field || !rows) return;
    // Just this cell's old value, never a snapshot of the whole grid: two
    // overlapping saves would otherwise share a stale array, and one
    // failing would roll back the other cell's edit on screen.
    const previous = rows.find((row) => row.id === rowId)?.values[fieldId];

    let next: CustomTableFieldValue | null = raw;
    if (typeof raw === "string") {
      const coerced = coerceFieldValue(field, raw);
      if (!coerced.ok) {
        setError(describeRowErrors(table.fields, [{ fieldId, code: coerced.code }]));
        return;
      }
      next = coerced.value;
    }

    setRows((prev) =>
      (prev ?? []).map((row) =>
        row.id === rowId
          ? {
              ...row,
              values:
                next === null
                  ? Object.fromEntries(
                      Object.entries(row.values).filter(([key]) => key !== fieldId)
                    )
                  : { ...row.values, [fieldId]: next }
            }
          : row
      )
    );
    setError(null);

    try {
      // Sending the key as an empty string is how "clear this" is expressed:
      // an absent key would read as "not mentioned" and merge to no change.
      await fetch(`${base}/rows/${encodeURIComponent(rowId)}?${suffix}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { [fieldId]: next === null ? "" : next } })
      }).then((r) => readEnvelope<unknown>(r));
    } catch (e) {
      setRows((prev) =>
        (prev ?? []).map((row) => {
          if (row.id !== rowId) return row;
          const values = { ...row.values };
          if (previous === undefined) delete values[fieldId];
          else values[fieldId] = previous;
          return { ...row, values };
        })
      );
      setError(e instanceof Error ? e.message : t("saveFailed"));
    }
  };

  /** Attach or detach the person a contact-linked row is about. */
  const setRowContact = async (
    rowId: string,
    contact: { id: string; name: string | null; e164: string } | null
  ) => {
    setError(null);
    try {
      await fetch(`${base}/rows/${encodeURIComponent(rowId)}?${suffix}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact?.id ?? null })
      }).then((r) => readEnvelope<unknown>(r));
      // Patch THIS row only, from what the picker already knew. Reloading
      // the grid would race a cell save still in flight (blur fires just
      // before the picker click, which is the normal way to fill a row in)
      // and could paint a stale cell over a write that succeeded.
      setRows((prev) =>
        (prev ?? []).map((row) =>
          row.id === rowId
            ? {
                ...row,
                contactId: contact?.id ?? null,
                contactName: contact?.name ?? null,
                contactE164: contact?.e164 ?? null
              }
            : row
        )
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    }
  };

  const addRow = async () => {
    setBusy(true);
    setError(null);
    try {
      // A blank starter row, on purpose: a spreadsheet lets you make the row
      // and then fill it in. The server treats an empty bag as blank and
      // skips the required check for it; required columns still hold for a
      // real submission, including everything the coworker writes. The
      // drawer opens straight after so the owner can fill them in.
      const data = await fetch(`${base}/rows?${suffix}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: {} })
      }).then((r) => readEnvelope<{ row: { id: string } }>(r));
      await load(query);
      setDrawerRowId(data.row.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const deleteRow = async (rowId: string) => {
    if (!window.confirm(t("deleteRowConfirm"))) return;
    setError(null);
    try {
      await fetch(`${base}/rows/${encodeURIComponent(rowId)}?${suffix}`, {
        method: "DELETE"
      }).then((r) => readEnvelope<unknown>(r));
      setRows((prev) => (prev ?? []).filter((row) => row.id !== rowId));
      if (drawerRowId === rowId) setDrawerRowId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("deleteFailed"));
    }
  };

  const patchTable = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await fetch(`${base}?${suffix}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then((r) => readEnvelope<{ table: CustomTable; swept?: number }>(r));
      setTable(data.table);
      if (data.swept) setNotice(t("schemaSwept", { count: data.swept }));
      await load(query);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("schemaFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const deleteTable = async () => {
    setBusy(true);
    try {
      await fetch(`${base}?${suffix}`, { method: "DELETE" }).then((r) => readEnvelope<unknown>(r));
      router.push("/dashboard/tables");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("deleteFailed"));
      setBusy(false);
    }
  };

  const restoreVersion = async (versionId: number) => {
    setError(null);
    try {
      await fetch(`${base}/versions?${suffix}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId })
      }).then((r) => readEnvelope<unknown>(r));
      setNotice(t("historyRestored"));
      await load(query);
      await loadHistory();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("historyFailed"));
    }
  };

  const drawerRow = rows?.find((row) => row.id === drawerRowId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{table.name}</h1>
          {table.description && (
            <p className="mt-1 text-sm text-parchment/50">{table.description}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void load(query);
            }}
            className="flex items-center gap-1"
          >
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-parchment/30" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("search")}
                aria-label={t("search")}
                className="w-44 rounded-md border border-parchment/15 bg-deep-ink/40 py-1.5 pl-7 pr-2 text-xs text-parchment placeholder:text-parchment/30"
              />
            </div>
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  void load("");
                }}
                className="text-xs text-parchment/50 hover:text-parchment"
              >
                {t("clearSearch")}
              </button>
            )}
          </form>
          <button
            onClick={() => void load(query)}
            aria-label={t("refresh")}
            className="inline-flex items-center gap-1.5 rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/60 hover:text-parchment"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("refresh")}
          </button>
          <button
            onClick={() => openPanel("history")}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors ${
              panel === "history"
                ? "border-signal-teal/60 bg-signal-teal/15 text-signal-teal"
                : "border-parchment/15 text-parchment/60 hover:text-parchment"
            }`}
          >
            <History className="h-3.5 w-3.5" />
            {t("historyButton")}
          </button>
          {canManage && (
            <button
              onClick={() => openPanel("columns")}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                panel === "columns"
                  ? "border-signal-teal/60 bg-signal-teal/15 text-signal-teal"
                  : "border-parchment/15 text-parchment/60 hover:text-parchment"
              }`}
            >
              <Columns3 className="h-3.5 w-3.5" />
              {t("columnsButton")}
            </button>
          )}
          <button
            onClick={() => void addRow()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-claw-green px-3 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-opacity-90 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {busy ? t("adding") : t("addRow")}
          </button>
        </div>
      </div>

      {justCreated && (
        <Card padding="sm">
          <p className="text-xs text-parchment/60">{t("emptyRowsCoworkerHint")}</p>
        </Card>
      )}

      {(error || notice) && (
        <Card padding="sm">
          <div className="flex items-center justify-between gap-3">
            <p className={`text-sm ${error ? "text-spark-orange" : "text-parchment/60"}`}>
              {error ?? notice}
            </p>
            <button
              onClick={() => {
                setError(null);
                setNotice(null);
              }}
              className="text-parchment/40 hover:text-parchment"
              aria-label={t("dismiss")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </Card>
      )}

      {panel === "columns" && canManage && (
        <TableColumnsEditor
          table={table}
          busy={busy}
          onPatch={patchTable}
          onRename={(name) => patchTable({ action: "rename", name })}
          onDeleteTable={() => void deleteTable()}
        />
      )}

      {panel === "history" && (
        <CustomTableHistory entries={history} canManage={canManage} onRestore={restoreVersion} />
      )}

      {rows !== null && rows.length === 0 && (
        <Card>
          <div className="space-y-2 py-6 text-center">
            <p className="text-sm text-parchment/70">
              {query ? t("noMatch") : t("emptyRowsTitle", { name: table.name })}
            </p>
            {!query && (
              <>
                <p className="text-sm text-parchment/50">{t("emptyRowsBody")}</p>
                {/* The just-created banner already says this, and saying it
                    twice on one screen reads as a rendering bug. */}
                {!justCreated && (
                  <p className="text-xs text-parchment/40">{t("emptyRowsCoworkerHint")}</p>
                )}
              </>
            )}
          </div>
        </Card>
      )}

      {rows !== null && rows.length > 0 && (
        <CustomTableGrid
          fields={table.fields}
          rows={rows}
          showContactColumn={table.rowLink === "contact"}
          canEdit
          onSaveCell={saveCell}
          onOpenRow={setDrawerRowId}
          onDeleteRow={(rowId) => void deleteRow(rowId)}
        />
      )}

      {drawerRow && (
        <TableRowDrawer
          businessId={businessId}
          table={table}
          row={drawerRow}
          onClose={() => setDrawerRowId(null)}
          onSaveCell={saveCell}
          onSetContact={setRowContact}
          onDelete={() => void deleteRow(drawerRow.id)}
        />
      )}
    </div>
  );
}
