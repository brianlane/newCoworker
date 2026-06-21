"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import type { SortDir } from "@/lib/dashboard/sort";

export type SortOption = { key: string; label: string };

/**
 * Compact "Sort by [field] [↑/↓]" control shared by the dashboard list views.
 * Stateless: the parent owns the {field, dir} and re-sorts its already-loaded
 * rows with sortRows. The direction button toggles asc/desc for the current
 * field.
 */
export function SortControl({
  options,
  field,
  dir,
  onChange,
  idPrefix = "sort"
}: {
  options: SortOption[];
  field: string;
  dir: SortDir;
  onChange: (field: string, dir: SortDir) => void;
  idPrefix?: string;
}) {
  const selectId = `${idPrefix}-field`;
  const current = options.find((o) => o.key === field);
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={selectId} className="text-xs text-parchment/50">
        Sort
      </label>
      <select
        id={selectId}
        value={field}
        onChange={(e) => onChange(e.target.value, dir)}
        className="rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1 text-xs text-parchment focus:border-signal-teal/60 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onChange(field, dir === "asc" ? "desc" : "asc")}
        title={dir === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
        aria-label={`Sort by ${current?.label ?? field}, ${dir === "asc" ? "ascending" : "descending"}`}
        className="rounded-md border border-parchment/15 p-1 text-parchment/70 hover:bg-parchment/5 hover:text-parchment transition-colors"
      >
        {dir === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
