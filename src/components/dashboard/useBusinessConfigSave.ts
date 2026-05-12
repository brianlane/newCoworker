"use client";

import { useCallback, useState } from "react";
import { postBusinessConfigSave } from "@/lib/business-config-save-client";

const SAVED_INDICATOR_MS = 3000;

export function useBusinessConfigSave() {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const clearSaveError = useCallback(() => setSaveError(null), []);

  const save = useCallback(async (body: Record<string, unknown>) => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await postBusinessConfigSave(body);
      if (!result.ok) {
        setSaveError(result.errorMessage);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), SAVED_INDICATOR_MS);
    } finally {
      setSaving(false);
    }
  }, []);

  return { saving, saved, saveError, clearSaveError, save };
}
