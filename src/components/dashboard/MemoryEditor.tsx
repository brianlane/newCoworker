"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";

interface MemoryEditorProps {
  businessId: string;
  initialSoul: string;
  initialIdentity: string;
  initialMemory: string;
}

export function MemoryEditor({
  businessId,
  initialSoul,
  initialIdentity,
  initialMemory
}: MemoryEditorProps) {
  const [soul, setSoul] = useState(initialSoul);
  const [identity, setIdentity] = useState(initialIdentity);
  const [memory, setMemory] = useState(initialMemory);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/business/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, soulMd: soul, identityMd: identity, memoryMd: memory })
      });
      if (!res.ok) throw new Error("Save failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <h3 className="text-sm font-semibold text-parchment mb-3 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-claw-green" />
          Soul (Personality &amp; Ethics)
        </h3>
        <Textarea
          value={soul}
          onChange={(e) => setSoul(e.target.value)}
          rows={6}
          placeholder="Core personality, ethics, and communication style..."
        />
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-parchment mb-3 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-claw-green" />
          Identity (Business Facts)
        </h3>
        <Textarea
          value={identity}
          onChange={(e) => setIdentity(e.target.value)}
          rows={6}
          placeholder="Business name, market, services, team info..."
        />
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-parchment mb-3 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-claw-green" />
          Memory (Learned Facts)
        </h3>
        <Textarea
          value={memory}
          onChange={(e) => setMemory(e.target.value)}
          rows={8}
          placeholder="Accumulated business knowledge..."
        />
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} loading={saving}>
          Save Changes
        </Button>
        {saved && <span className="text-sm text-claw-green">✓ Saved</span>}
      </div>
    </div>
  );
}
