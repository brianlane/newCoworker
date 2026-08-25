"use client";

/**
 * The spreadsheet itself: type-driven cells with inline editing.
 *
 * Built fresh rather than extracted from LeadDataGrid. That grid's cells are
 * ENTITY-driven (a Stage cell knows about pipelines and fires tag automation
 * on change); these are TYPE-driven (a date cell knows about dates). They
 * are different components that happen to both render a table, and turning
 * one into the other would mean a props bag of a dozen optional fields
 * serving one real consumer plus one hostage.
 *
 * Saves are optimistic per cell with a revert on failure, the moveLead
 * pattern from the board.
 */
import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ChevronRight, Trash2 } from "lucide-react";
import { formatFieldValue } from "@/lib/custom-tables/core";
import type {
  CustomTableField,
  CustomTableFieldValue,
  CustomTableRowWithContact
} from "@/lib/custom-tables/types";

type Props = {
  fields: CustomTableField[];
  rows: CustomTableRowWithContact[];
  showContactColumn: boolean;
  canEdit: boolean;
  onSaveCell: (rowId: string, fieldId: string, raw: CustomTableFieldValue | null) => Promise<void>;
  onOpenRow: (rowId: string) => void;
  onDeleteRow: (rowId: string) => void;
};

/** One cell's editor, chosen by the column's type. */
function Cell({
  field,
  value,
  canEdit,
  onCommit,
  onOpenRow
}: {
  field: CustomTableField;
  value: CustomTableFieldValue | undefined;
  canEdit: boolean;
  onCommit: (next: CustomTableFieldValue | null) => void;
  onOpenRow: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const rendered = formatFieldValue(value);

  if (!canEdit) {
    return <span className="block max-w-56 truncate text-parchment/70">{rendered}</span>;
  }

  if (field.type === "checkbox") {
    return (
      <input
        type="checkbox"
        checked={value === true}
        aria-label={field.label}
        onChange={(e) => onCommit(e.target.checked)}
        className="h-4 w-4 accent-signal-teal"
      />
    );
  }

  if (field.type === "select") {
    return (
      <select
        value={typeof value === "string" ? value : ""}
        aria-label={field.label}
        onChange={(e) => onCommit(e.target.value === "" ? null : e.target.value)}
        className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-xs text-parchment"
      >
        <option value="">-</option>
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  // A textarea inline would make every row a different height, so long text
  // opens the drawer instead and the cell shows a one-line preview.
  if (field.type === "long_text" || field.type === "multi_select") {
    return (
      <button
        type="button"
        onClick={onOpenRow}
        className="block max-w-56 truncate text-left text-parchment/70 hover:text-parchment"
      >
        {rendered || <span className="text-parchment/25">-</span>}
      </button>
    );
  }

  const inputType = field.type === "date" ? "date" : "text";
  return (
    <input
      type={inputType}
      inputMode={field.type === "number" ? "decimal" : undefined}
      aria-label={field.label}
      value={draft ?? rendered}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const next = draft.trim();
        setDraft(null);
        if (next === rendered) return;
        onCommit(next === "" ? null : next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      className="w-full max-w-56 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-parchment/80 hover:border-parchment/15 focus:border-signal-teal/50 focus:outline-none"
    />
  );
}

export function CustomTableGrid({
  fields,
  rows,
  showContactColumn,
  canEdit,
  onSaveCell,
  onOpenRow,
  onDeleteRow
}: Props) {
  const t = useTranslations("dashboard.tables");
  const shown = fields.filter((f) => f.enabled);

  return (
    <div className="overflow-x-auto rounded-lg border border-parchment/10">
      <table className="w-full min-w-max text-left text-sm">
        <thead>
          <tr className="border-b border-parchment/10 bg-parchment/5 text-xs uppercase tracking-wide text-parchment/40">
            {shown.map((field) => (
              <th key={field.id} className="px-3 py-2 font-medium">
                {field.label}
                {field.required && <span className="ml-0.5 text-spark-orange">*</span>}
              </th>
            ))}
            {showContactColumn && (
              <th className="px-3 py-2 font-medium">{t("contactColumn")}</th>
            )}
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-parchment/5 hover:bg-parchment/5">
              {shown.map((field) => (
                <td key={field.id} className="px-3 py-1.5 align-middle">
                  <Cell
                    field={field}
                    value={row.values[field.id]}
                    canEdit={canEdit}
                    onCommit={(next) => void onSaveCell(row.id, field.id, next)}
                    onOpenRow={() => onOpenRow(row.id)}
                  />
                </td>
              ))}
              {showContactColumn && (
                <td className="px-3 py-1.5 text-parchment/70">
                  {row.contactE164 ? (
                    <Link
                      href={`/dashboard/customers/${encodeURIComponent(row.contactE164)}`}
                      className="hover:text-signal-teal"
                    >
                      {row.contactName ?? row.contactE164}
                    </Link>
                  ) : (
                    <span className="text-parchment/25">{t("noContact")}</span>
                  )}
                </td>
              )}
              <td className="whitespace-nowrap px-3 py-1.5 text-right">
                <button
                  type="button"
                  onClick={() => onOpenRow(row.id)}
                  aria-label={t("openRow")}
                  className="text-parchment/40 hover:text-parchment"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => onDeleteRow(row.id)}
                    aria-label={t("deleteRow")}
                    className="ml-1.5 text-parchment/30 hover:text-spark-orange"
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
  );
}
