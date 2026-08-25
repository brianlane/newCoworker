"use client";

/**
 * One row, opened as a side panel.
 *
 * This is where long text is edited: an inline textarea in the grid would
 * make every row a different height. It is also where a row with required
 * columns gets its first values, since a blank row cannot be created with
 * them empty.
 *
 * Not a route. Deep-linking one row is not a v1 need and a drawer keeps the
 * grid's scroll position, but the page does read `?row=<id>` on mount, which
 * costs nothing and lets the coworker link straight to a row it just made.
 */
import { useTranslations } from "next-intl";
import { Trash2, X } from "lucide-react";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { formatFieldValue } from "@/lib/custom-tables/core";
import type {
  CustomTable,
  CustomTableFieldValue,
  CustomTableRowWithContact
} from "@/lib/custom-tables/types";

type Props = {
  table: CustomTable;
  row: CustomTableRowWithContact;
  onClose: () => void;
  onSaveCell: (rowId: string, fieldId: string, raw: CustomTableFieldValue | null) => Promise<void>;
  onDelete: () => void;
};

export function TableRowDrawer({ table, row, onClose, onSaveCell, onDelete }: Props) {
  const t = useTranslations("dashboard.tables");

  const commit = (fieldId: string, raw: string) => {
    const trimmed = raw.trim();
    void onSaveCell(row.id, fieldId, trimmed === "" ? null : trimmed);
  };

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-parchment/15 bg-deep-ink p-5 shadow-2xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-parchment">{t("rowDetailTitle")}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("closeRow")}
          className="text-parchment/40 hover:text-parchment"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3">
        {table.fields
          .filter((field) => field.enabled)
          .map((field) => {
            const value = row.values[field.id];
            const rendered = formatFieldValue(value);
            return (
              <label key={field.id} className="block text-xs text-parchment/50">
                {field.label}
                {field.required && <span className="ml-0.5 text-spark-orange">*</span>}
                {field.type === "long_text" ? (
                  <textarea
                    defaultValue={rendered}
                    rows={4}
                    onBlur={(e) => {
                      if (e.target.value.trim() === rendered) return;
                      commit(field.id, e.target.value);
                    }}
                    className="mt-1 block w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-sm text-parchment"
                  />
                ) : field.type === "checkbox" ? (
                  <input
                    type="checkbox"
                    checked={value === true}
                    onChange={(e) => void onSaveCell(row.id, field.id, e.target.checked)}
                    className="mt-1 block h-4 w-4 accent-signal-teal"
                  />
                ) : field.type === "select" ? (
                  <select
                    value={typeof value === "string" ? value : ""}
                    onChange={(e) =>
                      void onSaveCell(row.id, field.id, e.target.value === "" ? null : e.target.value)
                    }
                    className="mt-1 block w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-sm text-parchment"
                  >
                    <option value="">-</option>
                    {(field.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : field.type === "multi_select" ? (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {(field.options ?? []).map((option) => {
                      const chosen = Array.isArray(value) && value.includes(option);
                      return (
                        <button
                          key={option}
                          type="button"
                          onClick={() => {
                            const current = Array.isArray(value) ? value : [];
                            const next = chosen
                              ? current.filter((v) => v !== option)
                              : [...current, option];
                            void onSaveCell(row.id, field.id, next.length > 0 ? next : null);
                          }}
                          className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                            chosen
                              ? "border-signal-teal/60 bg-signal-teal/15 text-signal-teal"
                              : "border-parchment/15 text-parchment/50 hover:text-parchment"
                          }`}
                        >
                          {option}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <input
                    // Date stays date-only: routing it through a timestamp
                    // formatter would shift a birthday across a timezone.
                    type={field.type === "date" ? "date" : "text"}
                    inputMode={field.type === "number" ? "decimal" : undefined}
                    defaultValue={rendered}
                    onBlur={(e) => {
                      if (e.target.value.trim() === rendered) return;
                      commit(field.id, e.target.value);
                    }}
                    className="mt-1 block w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-sm text-parchment"
                  />
                )}
                {field.help && <span className="mt-0.5 block text-[11px] text-parchment/30">{field.help}</span>}
              </label>
            );
          })}
      </div>

      {table.rowLink === "contact" && (
        <p className="mt-4 text-xs text-parchment/50">
          {t("contactColumn")}:{" "}
          {row.contactName ?? row.contactE164 ?? (
            <span className="text-parchment/30">{t("noContact")}</span>
          )}
        </p>
      )}

      <div className="mt-5 space-y-1 border-t border-parchment/10 pt-3 text-[11px] text-parchment/35">
        <p>
          {t("createdAt", { when: "" })}
          <LocalDateTime iso={row.createdAt} />
        </p>
        <p>
          {t("updatedAt", { when: "" })}
          <LocalDateTime iso={row.updatedAt} />
        </p>
      </div>

      <button
        type="button"
        onClick={onDelete}
        className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-spark-orange/30 px-2.5 py-1 text-xs text-spark-orange/80 hover:text-spark-orange"
      >
        <Trash2 className="h-3 w-3" />
        {t("deleteRow")}
      </button>
    </div>
  );
}
