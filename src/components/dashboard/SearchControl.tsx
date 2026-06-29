"use client";

import { Search, X } from "lucide-react";

/**
 * Compact search box shared by the dashboard list views. Stateless: the parent
 * owns the query string and filters its already-loaded rows with `matchesQuery`.
 * A clear (×) button appears once there's text so a filtered list is one click
 * from showing everything again.
 */
export function SearchControl({
  value,
  onChange,
  placeholder = "Search…",
  idPrefix = "search"
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  idPrefix?: string;
}) {
  const inputId = `${idPrefix}-input`;
  return (
    <div className="relative">
      <label htmlFor={inputId} className="sr-only">
        Search
      </label>
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-parchment/40" />
      <input
        id={inputId}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-parchment/15 bg-deep-ink/60 py-1 pl-7 pr-7 text-xs text-parchment placeholder:text-parchment/40 focus:border-signal-teal/60 focus:outline-none sm:w-56"
      />
      {value.length > 0 && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-parchment/40 hover:text-parchment"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
