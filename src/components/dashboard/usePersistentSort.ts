"use client";

import { useEffect, useState } from "react";
import type { SortDir } from "@/lib/dashboard/sort";

export type SortState = { field: string; dir: SortDir };

/**
 * Sort state that survives navigation + reload by mirroring to localStorage.
 *
 * Initializes with `defaultSort` so the server-rendered markup and the first
 * client paint agree (no hydration mismatch); a stored value is applied in an
 * effect right after mount. Each change is written back under `storageKey`.
 * Guards against unknown stored fields so a renamed sort option can't strand
 * the control on a value the list no longer understands.
 */
export function usePersistentSort(
  storageKey: string,
  defaultSort: SortState,
  validFields: readonly string[]
): [SortState, (field: string, dir: SortDir) => void] {
  const [sort, setSortState] = useState<SortState>(defaultSort);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<SortState>;
      const field =
        typeof parsed.field === "string" && validFields.includes(parsed.field)
          ? parsed.field
          : null;
      const dir = parsed.dir === "asc" || parsed.dir === "desc" ? parsed.dir : null;
      if (field && dir) setSortState({ field, dir });
    } catch {
      // Corrupt/blocked storage → keep the default. Never throw from a read.
    }
    // validFields is a stable literal per call site; keying off storageKey is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const setSort = (field: string, dir: SortDir) => {
    setSortState({ field, dir });
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ field, dir }));
    } catch {
      // Storage full/blocked (private mode): persistence degrades silently;
      // in-session sort still works off React state.
    }
  };

  return [sort, setSort];
}
