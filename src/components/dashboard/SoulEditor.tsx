"use client";

import { useMemo, useState } from "react";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import {
  BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS,
  BUSINESS_CONFIG_SOUL_MD_MAX_CHARS
} from "@/lib/vault/business-config-markdown-limits";

interface SoulEditorProps {
  businessId: string;
  initialSoul: string;
  initialIdentity: string;
}

export function SoulEditor({ businessId, initialSoul, initialIdentity }: SoulEditorProps) {
  const [soul, setSoul] = useState(initialSoul);
  const [identity, setIdentity] = useState(initialIdentity);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const charLimitIssue = useMemo(() => {
    if (soul.length > BUSINESS_CONFIG_SOUL_MD_MAX_CHARS) {
      return `Soul exceeds ${BUSINESS_CONFIG_SOUL_MD_MAX_CHARS.toLocaleString()} characters`;
    }
    if (identity.length > BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS) {
      return `Identity exceeds ${BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS.toLocaleString()} characters`;
    }
    return null;
  }, [soul, identity]);

  async function handleSave() {
    if (charLimitIssue) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/business/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          soulMd: soul,
          identityMd: identity
        })
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { message?: string } }
        | null;
      if (!res.ok) {
        const msg =
          payload?.ok === false && typeof payload.error?.message === "string"
            ? payload.error.message
            : "Save failed";
        setSaveError(msg);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Could not save. Check your connection and try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {charLimitIssue && (
        <p className="text-sm text-rose-300 border border-rose-500/40 rounded-lg px-3 py-2 bg-rose-950/30">
          {charLimitIssue}. Trim the text before saving.
        </p>
      )}
      {saveError && (
        <p className="text-sm text-rose-300 border border-rose-500/40 rounded-lg px-3 py-2 bg-rose-950/30">
          {saveError}
        </p>
      )}
      <div>
        <Textarea
          label="Soul (Personality & Ethics)"
          value={soul}
          onChange={(e) => {
            setSoul(e.target.value);
            setSaveError(null);
          }}
          rows={5}
        />
        <p className="mt-2 text-xs text-parchment/40">
          {soul.length.toLocaleString()} / {BUSINESS_CONFIG_SOUL_MD_MAX_CHARS.toLocaleString()} characters
        </p>
      </div>
      <div>
        <Textarea
          label="Identity (Business Facts)"
          value={identity}
          onChange={(e) => {
            setIdentity(e.target.value);
            setSaveError(null);
          }}
          rows={5}
        />
        <p className="mt-2 text-xs text-parchment/40">
          {identity.length.toLocaleString()} / {BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS.toLocaleString()}{" "}
          characters
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={handleSave} loading={saving} disabled={Boolean(charLimitIssue)}>
          Save
        </Button>
        {saved && <span className="text-xs text-claw-green">✓ Saved</span>}
      </div>
    </div>
  );
}
