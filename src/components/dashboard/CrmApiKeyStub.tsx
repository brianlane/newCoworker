"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function CrmApiKeyStub() {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <Input
        type="password"
        name="crmKey"
        placeholder="API key (vault — coming soon)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="text-sm"
        autoComplete="off"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" variant="secondary" size="sm">
          Save to vault
        </Button>
        {saved && <span className="text-xs text-claw-green">Stub only — key not stored</span>}
      </div>
      <p className="text-[10px] text-parchment/35">
        Encrypted CRM keys will sync to your coworker&apos;s VPS when this feature ships.
      </p>
    </form>
  );
}
