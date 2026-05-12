"use client";

import { useMemo, useState } from "react";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import {
  BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS,
  BUSINESS_CONFIG_SOUL_MD_MAX_CHARS
} from "@/lib/vault/business-config-markdown-limits";
import { useBusinessConfigSave } from "@/components/dashboard/useBusinessConfigSave";

interface SoulEditorProps {
  businessId: string;
  initialSoul: string;
  initialIdentity: string;
}

export function SoulEditor({ businessId, initialSoul, initialIdentity }: SoulEditorProps) {
  const [soul, setSoul] = useState(initialSoul);
  const [identity, setIdentity] = useState(initialIdentity);
  const { saving, saved, saveError, clearSaveError, save } = useBusinessConfigSave();

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
    await save({
      businessId,
      soulMd: soul,
      identityMd: identity
    });
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
            clearSaveError();
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
            clearSaveError();
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
