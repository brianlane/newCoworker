"use client";

import { Search, X } from "lucide-react";

/**
 * Compact search box shared by the dashboard list views. Stateless: the parent
 * owns the query string and filters its already-loaded rows with `matchesQuery`.
 * A clear (×) button appears once there's text so a filtered list is one click
 * from showing everything again.
 *
 * That button is why the input suppresses `::-webkit-search-cancel-button`.
 * `type="search"` makes Chrome and Safari draw their OWN clear button once the
 * field has focus, so a focused box showed two ×s side by side: the browser's
 * blue one and ours. Reported on the Emails page, Aug 18 2026.
 *
 * The type stays `search` rather than becoming `text`, because it is what gives
 * the field its searchbox role for assistive tech and the Escape-to-clear
 * behavior. Only the duplicate decoration goes, the same way the marketing FAQ
 * hides `::-webkit-details-marker`. Firefox draws no such button, so this is a
 * WebKit/Blink-only decoration and there is nothing to suppress elsewhere.
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
    // Grows to the available row width below md — the mobile 16px form-control
    // font needs the room for the placeholder — and hugs the fixed input at md+.
    <div className="relative min-w-0 grow md:grow-0">
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
        // Full width below md: the mobile CSS bumps form controls to 16px
        // (iOS anti-zoom), which needs the extra room; at md+ the 12px text
        // fits comfortably in a fixed 16rem box.
        className="w-full rounded-md border border-parchment/15 bg-deep-ink/60 py-1 pl-7 pr-7 text-xs text-parchment placeholder:text-parchment/40 focus:border-signal-teal/60 focus:outline-none md:w-64 [&::-webkit-search-cancel-button]:hidden"
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
