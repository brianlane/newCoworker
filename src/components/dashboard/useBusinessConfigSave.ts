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
 * Native leave-page prompt while an editor holds unsaved changes (tenant
 * feedback: prompt edits were silently lost by navigating away). Covers tab
 * close, reload, and hard navigation; browsers show their own generic
 * wording, the string itself is ignored.
 */
export function useUnsavedChangesWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome still requires returnValue for the prompt to appear.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}
