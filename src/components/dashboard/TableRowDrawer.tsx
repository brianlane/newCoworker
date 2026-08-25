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
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Trash2, User, X } from "lucide-react";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { formatFieldValue } from "@/lib/custom-tables/core";
import type {
  CustomTable,
  CustomTableFieldValue,
  CustomTableRowWithContact
} from "@/lib/custom-tables/types";

type Props = {
  businessId: string;
  table: CustomTable;
  row: CustomTableRowWithContact;
  onClose: () => void;
  onSaveCell: (rowId: string, fieldId: string, raw: CustomTableFieldValue | null) => Promise<void>;
  onSetContact: (rowId: string, contactId: string | null) => Promise<void>;
  onDelete: () => void;
};

type ContactHit = { id: string; displayName: string | null; customerE164: string };

/**
 * Type-ahead over the business's contacts, for a table whose rows each
 * belong to one person.
 *
 * The creation wizard promises "you pick the person when you add a row", so
 * this has to exist or that sentence is a lie: a Policies table would fill
 * up with rows attached to nobody.
 */
function ContactPicker({
  businessId,
  row,
  onPick,
  onClear
}: {
  businessId: string;
  row: CustomTableRowWithContact;
  onPick: (contactId: string) => void;
  onClear: () => void;
}) {
  const t = useTranslations("dashboard.tables");
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = search.trim();
    // Everything runs inside the debounce callback, never synchronously in
    // the effect body, so the set-state-in-effect rule does not apply.
    timer.current = setTimeout(() => {
      if (!q) {
        setHits([]);
        return;
      }
      void fetch(
        `/api/dashboard/customers?businessId=${encodeURIComponent(businessId)}&search=${encodeURIComponent(q)}&limit=8`,
        { cache: "no-store" }
      )
        .then((r) => r.json())
        .then((json) => setHits(json?.data?.customers ?? []))
        .catch(() => setHits([]));
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [search, businessId]);

  if (row.contactId) {
    return (
      <div className="mt-1 flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-parchment/10 px-2 py-1 text-xs text-parchment/80">
          <User className="h-3 w-3" />
          {row.contactName ?? row.contactE164}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="text-parchment/40 hover:text-parchment"
          aria-label={t("clearContact")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative mt-1">
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("contactSearchPlaceholder")}
        aria-label={t("pickContact")}
        className="block w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-sm text-parchment placeholder:text-parchment/30"
      />
      {hits.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-40 w-full overflow-y-auto rounded-md border border-parchment/15 bg-deep-ink">
          {hits.map((hit) => (
            <button
              key={hit.id}
              type="button"
              onClick={() => {
                onPick(hit.id);
                setSearch("");
                setHits([]);
              }}
              className="block w-full px-2 py-1.5 text-left text-xs text-parchment/80 hover:bg-parchment/10"
            >
              {hit.displayName ?? hit.customerE164}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TableRowDrawer({
  businessId,
  table,
  row,
  onClose,
  onSaveCell,
  onSetContact,
  onDelete
}: Props) {
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
        <div className="mt-4">
          <span className="text-xs text-parchment/50">{t("contactColumn")}</span>
          <ContactPicker
            businessId={businessId}
            row={row}
            onPick={(contactId) => void onSetContact(row.id, contactId)}
            onClear={() => void onSetContact(row.id, null)}
          />
        </div>
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
