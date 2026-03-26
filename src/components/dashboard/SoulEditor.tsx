"use client";

import { useState } from "react";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";

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

  async function handleSave() {
    setSaving(true);
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
      if (!res.ok) throw new Error("Save failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Textarea
        label="Soul (Personality & Ethics)"
        value={soul}
        onChange={(e) => setSoul(e.target.value)}
        rows={5}
      />
      <Textarea
        label="Identity (Business Facts)"
        value={identity}
        onChange={(e) => setIdentity(e.target.value)}
        rows={5}
      />
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={handleSave} loading={saving}>
          Save
        </Button>
        {saved && <span className="text-xs text-claw-green">✓ Saved</span>}
      </div>
    </div>
  );
}
