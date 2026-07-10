"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { postBusinessConfigSave } from "@/lib/business-config-save-client";

const SAVED_INDICATOR_MS = 3000;

export function useBusinessConfigSave() {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const clearSaveError = useCallback(() => setSaveError(null), []);

  /** Returns true when the save persisted (lets callers reset dirty state). */
  const save = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    try {
      const result = await postBusinessConfigSave(body);
      if (!result.ok) {
        setSaveError(result.errorMessage);
        return false;
      }
      setSaved(true);
      savedTimerRef.current = setTimeout(() => {
        setSaved(false);
        savedTimerRef.current = null;
      }, SAVED_INDICATOR_MS);
      return true;
    } finally {
      setSaving(false);
    }
  }, []);

  return { saving, saved, saveError, clearSaveError, save };
}

/**
 * Leave-page protection while an editor holds unsaved changes (tenant
 * feedback: prompt/flow edits were silently lost by navigating away).
 *
 * Two layers, because they cover disjoint exits:
 *  - `beforeunload` for tab close, reload, and full-page navigation
 *    (browsers show their own generic wording; the string is ignored).
 *  - a capture-phase click interceptor for SAME-ORIGIN anchor clicks —
 *    Next.js `<Link>` navigations (the dashboard sidebar!) are client-side
 *    route changes that never fire beforeunload, and the App Router has no
 *    supported route-change veto, so the click itself is the only reliable
 *    chokepoint. New-tab/download/modified clicks pass through untouched
 *    (they don't unload this page), and cross-origin links are left to the
 *    beforeunload layer so the user isn't prompted twice.
 */
export function useUnsavedChangesWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome still requires returnValue for the prompt to appear.
      e.returnValue = "";
    };
    const onClickCapture = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const target = anchor.getAttribute("target");
      if (target && target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href || href.startsWith("#")) return;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (!window.confirm("You have unsaved changes. Leave this page and discard them?")) {
        // Runs in the capture phase at document level, so this lands before
        // the Link's own handler — preventDefault stops the route change.
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [dirty]);
}
