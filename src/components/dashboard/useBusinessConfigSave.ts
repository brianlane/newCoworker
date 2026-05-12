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

  const save = useCallback(async (body: Record<string, unknown>) => {
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
        return;
      }
      setSaved(true);
      savedTimerRef.current = setTimeout(() => {
        setSaved(false);
        savedTimerRef.current = null;
      }, SAVED_INDICATOR_MS);
    } finally {
      setSaving(false);
    }
  }, []);

  return { saving, saved, saveError, clearSaveError, save };
}
