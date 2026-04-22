"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Textarea } from "@/components/ui/Textarea";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { starterVaultBudgetStatus } from "@/lib/vault/starterContextBudget";
import { websiteIngestErrorMessage } from "@/lib/website-ingest-copy";

interface MemoryEditorProps {
  businessId: string;
  /** When `starter`, shows a soft warning if combined vault text is large (KVM2 TTFT risk). */
  tier?: "starter" | "standard" | "enterprise";
  businessName?: string;
  businessType?: string;
  initialSoul: string;
  initialIdentity: string;
  initialMemory: string;
  initialWebsiteUrl: string;
  initialWebsiteMd: string;
}

type RecrawlState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "success"; pages: number; preview: string }
  | { status: "error"; message: string };

export function MemoryEditor({
  businessId,
  tier,
  businessName,
  businessType,
  initialSoul,
  initialIdentity,
  initialMemory,
  initialWebsiteUrl,
  initialWebsiteMd
}: MemoryEditorProps) {
  const [soul, setSoul] = useState(initialSoul);
  const [identity, setIdentity] = useState(initialIdentity);
  const [memory, setMemory] = useState(initialMemory);
  const [websiteUrl, setWebsiteUrl] = useState(initialWebsiteUrl);
  const [websiteMd, setWebsiteMd] = useState(initialWebsiteMd);
  const [recrawl, setRecrawl] = useState<RecrawlState>({ status: "idle" });

  const starterBudget = useMemo(() => {
    if (tier !== "starter") return null;
    // `websiteMd` is up to 8k chars (~2k tokens) and is shipped to the vault
    // alongside soul/identity/memory, so it must factor into the KVM2 budget.
    return starterVaultBudgetStatus(soul, identity, memory, websiteMd);
  }, [tier, soul, identity, memory, websiteMd]);
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
          identityMd: identity,
          memoryMd: memory,
          websiteMd,
          websiteUrl
        })
      });
      if (!res.ok) throw new Error("Save failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  }

  async function handleRecrawl() {
    if (!websiteUrl.trim()) {
      setRecrawl({ status: "error", message: "Enter a website URL first." });
      return;
    }
    setRecrawl({ status: "running" });
    try {
      const res = await fetch("/api/onboard/website-ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          websiteUrl: websiteUrl.trim(),
          businessName,
          businessType
        })
      });
      const json = (await res.json().catch(() => null)) as
        | {
            ok: boolean;
            data?: {
              ok?: boolean;
              pagesCrawled?: number;
              websiteMdPreview?: string;
              websiteMd?: string;
              error?: string;
              detail?: string | null;
            };
            error?: { message?: string };
          }
        | null;

      if (!res.ok || !json?.ok) {
        throw new Error(json?.error?.message ?? "Re-crawl failed");
      }
      const inner = json.data ?? {};
      if (inner.ok === false) {
        setRecrawl({
          status: "error",
          message: websiteIngestErrorMessage(inner.error, inner.detail)
        });
        return;
      }
      if (typeof inner.websiteMd === "string") {
        setWebsiteMd(inner.websiteMd);
      }
      setRecrawl({
        status: "success",
        pages: inner.pagesCrawled ?? 0,
        preview: inner.websiteMdPreview ?? ""
      });
    } catch (err) {
      setRecrawl({
        status: "error",
        message: err instanceof Error ? err.message : "Re-crawl failed"
      });
    }
  }

  return (
    <div className="space-y-5">
      {starterBudget?.overBudget && (
        <p className="text-sm text-amber-200/90 border border-amber-500/40 rounded-lg px-3 py-2 bg-amber-950/30">
          Starter tier: combined Soul + Identity + Memory + Website is large (~{starterBudget.estimatedTotal}{" "}
          estimated tokens vs ~{starterBudget.maxTokens} target). Very long vault text can slow responses on
          your coworker&apos;s KVM2 instance—consider trimming less-used detail or re-crawling a shorter
          landing page.
        </p>
      )}
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

      <Card>
        <div className="mb-3 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-claw-green" />
          <h3 className="text-sm font-semibold text-parchment">Website Knowledge</h3>
        </div>
        <p className="text-xs text-parchment/50 mb-3">
          We crawl your public site once during onboarding and summarize it into the snippet below. Your
          coworker draws on this for both SMS and voice calls. Edit manually, or paste a new URL and
          click <span className="text-parchment/70">Re-crawl</span> to regenerate.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Website URL"
              type="url"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder="https://yourbusiness.com"
              autoComplete="url"
            />
          </div>
          <Button
            onClick={handleRecrawl}
            loading={recrawl.status === "running"}
            variant="secondary"
            className="sm:mb-0"
          >
            Re-crawl
          </Button>
        </div>
        {recrawl.status === "success" && (
          <p className="mt-2 text-xs text-claw-green">
            Refreshed from {recrawl.pages} page{recrawl.pages === 1 ? "" : "s"}.
          </p>
        )}
        {recrawl.status === "error" && (
          <p className="mt-2 text-xs text-rose-300">{recrawl.message}</p>
        )}
        <div className="mt-3">
          <Textarea
            value={websiteMd}
            onChange={(e) => setWebsiteMd(e.target.value)}
            rows={10}
            placeholder="Website summary (markdown). Regenerated when you re-crawl; edits above can be kept if you don't re-crawl."
          />
        </div>
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
