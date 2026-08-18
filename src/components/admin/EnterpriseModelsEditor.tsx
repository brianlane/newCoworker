"use client";

/**
 * Admin "Designated models" card (enterprise): per-tenant reasoning/voice MODEL
 * ids. Saves to /api/admin/enterprise-models; values apply at the NEXT
 * deploy/redeploy of the tenant box (the orchestrator turns them into deploy
 * env), which the copy states explicitly.
 *
 * The VOICE picker is deliberately not here: it lives on the "Voice & SMS DID"
 * card, which every tier gets, and is live-applied per call. See
 * business_telnyx_settings.voice_name.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { type EnterpriseModels } from "@/lib/plans/enterprise-models";

export function EnterpriseModelsEditor({
  businessId,
  initialModels
}: {
  businessId: string;
  initialModels: EnterpriseModels | null;
}) {
  const router = useRouter();
  const [ownerChatModel, setOwnerChatModel] = useState(initialModels?.ownerChatModel ?? "");
  const [smsChatModel, setSmsChatModel] = useState(initialModels?.smsChatModel ?? "");
  const [geminiLiveModel, setGeminiLiveModel] = useState(initialModels?.geminiLiveModel ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(models: EnterpriseModels | null): Promise<boolean> {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/admin/enterprise-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, enterpriseModels: models })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Save failed");
        return false;
      }
      setSaved(true);
      router.refresh();
      return true;
    } catch {
      setError("Network error");
      return false;
    } finally {
      setLoading(false);
    }
  }

  function save() {
    const models: EnterpriseModels = {};
    if (ownerChatModel.trim()) models.ownerChatModel = ownerChatModel.trim();
    if (smsChatModel.trim()) models.smsChatModel = smsChatModel.trim();
    if (geminiLiveModel.trim()) models.geminiLiveModel = geminiLiveModel.trim();
    void submit(Object.keys(models).length > 0 ? models : null);
  }

  const inputCls =
    "w-full rounded-md bg-deep-ink border border-parchment/15 px-3 py-2 text-sm text-parchment";

  return (
    <div className="space-y-4 text-sm">
      <p className="text-parchment/50 text-xs">
        Per-tenant model overrides (empty = platform default). Chat slots take non-live
        gemini-* ids; voice takes a live-flavored, non-translate model. Changes apply on
        the NEXT deploy/redeploy of the tenant box, they are not live-applied. The voice
        itself is picked on the Voice &amp; SMS DID card and applies immediately.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-parchment/40">Owner chat model</span>
          <input
            className={inputCls}
            value={ownerChatModel}
            onChange={(e) => setOwnerChatModel(e.target.value)}
            placeholder="gemini-2.5-flash-lite"
            maxLength={64}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-parchment/40">SMS chat model</span>
          <input
            className={inputCls}
            value={smsChatModel}
            onChange={(e) => setSmsChatModel(e.target.value)}
            placeholder="gemini-2.5-flash-lite"
            maxLength={64}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-parchment/40">Voice model (live)</span>
          <input
            className={inputCls}
            value={geminiLiveModel}
            onChange={(e) => setGeminiLiveModel(e.target.value)}
            placeholder="gemini-3.1-flash-live-preview"
            maxLength={64}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <Button size="sm" onClick={save} loading={loading}>
          Save models
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            // Blank the form only AFTER the clear persists — emptying it
            // eagerly would show "no overrides" while the DB still has them
            // if the API call fails.
            const ok = await submit(null);
            if (ok) {
              setOwnerChatModel("");
              setSmsChatModel("");
              setGeminiLiveModel("");
            }
          }}
          loading={loading}
        >
          Clear overrides
        </Button>
        {saved && <span className="text-xs text-claw-green">Saved, applies at next redeploy</span>}
      </div>
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}
