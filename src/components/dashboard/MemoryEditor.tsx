"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Textarea } from "@/components/ui/Textarea";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import {
  BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS,
  BUSINESS_CONFIG_MEMORY_MD_MAX_CHARS,
  BUSINESS_CONFIG_SOUL_MD_MAX_CHARS,
  BUSINESS_CONFIG_WEBSITE_MD_MAX_CHARS
} from "@/lib/vault/business-config-markdown-limits";
import { starterVaultBudgetStatus } from "@/lib/vault/starterContextBudget";
import { websiteIngestErrorMessage } from "@/lib/website-ingest-copy";
import {
  useBusinessConfigSave,
  useUnsavedChangesWarning
} from "@/components/dashboard/useBusinessConfigSave";

export interface WebsiteCrawlReportView {
  crawledAt: string;
  source: string;
  pages: Array<{ url: string; chars: number }>;
}

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
  /** Last persisted crawl snapshot, shown under the Website Knowledge card. */
  initialCrawlReport?: WebsiteCrawlReportView | null;
}

interface CrawlProgress {
  fetched: number;
  failed: number;
  lastUrl: string | null;
  sitemapCount: number | null;
  summarizing: boolean;
}

type RecrawlState =
  | { status: "idle" }
  | { status: "running"; progress: CrawlProgress }
  | { status: "success"; pages: number; preview: string }
  | { status: "error"; message: string };

const EMPTY_PROGRESS: CrawlProgress = {
  fetched: 0,
  failed: 0,
  lastUrl: null,
  sitemapCount: null,
  summarizing: false
};

/** Show just the path of a crawled URL — the origin is the owner's own site. */
function crawlPathLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

export function MemoryEditor({
  businessId,
  tier,
  businessName,
  businessType,
  initialSoul,
  initialIdentity,
  initialMemory,
  initialWebsiteUrl,
  initialWebsiteMd,
  initialCrawlReport
}: MemoryEditorProps) {
  const [soul, setSoul] = useState(initialSoul);
  const [identity, setIdentity] = useState(initialIdentity);
  const [memory, setMemory] = useState(initialMemory);
  const [websiteUrl, setWebsiteUrl] = useState(initialWebsiteUrl);
  const [websiteMd, setWebsiteMd] = useState(initialWebsiteMd);
  const [recrawl, setRecrawl] = useState<RecrawlState>({ status: "idle" });
  const [crawlReport, setCrawlReport] = useState<WebsiteCrawlReportView | null>(
    initialCrawlReport ?? null
  );
  // WAF escape hatch: when a crawl fails (typically Cloudflare bot
  // protection blocking every server-side fetch), we open a box where the
  // owner can paste their homepage's "View Page Source" HTML and have it
  // summarized through the same pipeline.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pastedHtml, setPastedHtml] = useState("");

  const starterBudget = useMemo(() => {
    if (tier !== "starter") return null;
    // `websiteMd` is up to 8k chars (~2k tokens) and is shipped to the vault
    // alongside soul/identity/memory, so it must factor into the KVM2 budget.
    return starterVaultBudgetStatus(soul, identity, memory, websiteMd);
  }, [tier, soul, identity, memory, websiteMd]);
  const { saving, saved, saveError, clearSaveError, save } = useBusinessConfigSave();

  // Last-persisted values: edits are "dirty" until a save (or re-crawl,
  // which persists server-side) brings the baseline up to date.
  const [baseline, setBaseline] = useState({
    soul: initialSoul,
    identity: initialIdentity,
    memory: initialMemory,
    websiteUrl: initialWebsiteUrl,
    websiteMd: initialWebsiteMd
  });
  const dirty =
    soul !== baseline.soul ||
    identity !== baseline.identity ||
    memory !== baseline.memory ||
    websiteUrl !== baseline.websiteUrl ||
    websiteMd !== baseline.websiteMd;
  useUnsavedChangesWarning(dirty);

  const charLimitIssue = useMemo(() => {
    if (soul.length > BUSINESS_CONFIG_SOUL_MD_MAX_CHARS) {
      return `Soul exceeds ${BUSINESS_CONFIG_SOUL_MD_MAX_CHARS.toLocaleString()} characters`;
    }
    if (identity.length > BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS) {
      return `Identity exceeds ${BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS.toLocaleString()} characters`;
    }
    if (memory.length > BUSINESS_CONFIG_MEMORY_MD_MAX_CHARS) {
      return `Memory exceeds ${BUSINESS_CONFIG_MEMORY_MD_MAX_CHARS.toLocaleString()} characters`;
    }
    if (websiteMd.length > BUSINESS_CONFIG_WEBSITE_MD_MAX_CHARS) {
      return `Website knowledge exceeds ${BUSINESS_CONFIG_WEBSITE_MD_MAX_CHARS.toLocaleString()} characters`;
    }
    return null;
  }, [soul, identity, memory, websiteMd]);

  async function handleSave() {
    if (charLimitIssue) return;
    const ok = await save({
      businessId,
      soulMd: soul,
      identityMd: identity,
      memoryMd: memory,
      websiteMd,
      websiteUrl
    });
    if (ok) setBaseline({ soul, identity, memory, websiteUrl, websiteMd });
  }

  interface IngestResultLine {
    ok?: boolean;
    pagesCrawled?: number;
    websiteMdPreview?: string;
    websiteMd?: string;
    pages?: Array<{ url: string; chars: number }>;
    crawledAt?: string;
    error?: string;
    detail?: string | null;
  }

  function applyIngestResult(inner: IngestResultLine, source: "crawl" | "pasted_html") {
    if (inner.ok === false) {
      setRecrawl({
        status: "error",
        message: websiteIngestErrorMessage(inner.error, inner.detail)
      });
      // A failed crawl is exactly when the paste-source escape hatch is
      // needed — surface it without another click.
      setPasteOpen(true);
      return;
    }
    if (typeof inner.websiteMd === "string") {
      setWebsiteMd(inner.websiteMd);
      // The ingest endpoint persisted this server-side already — reflect
      // that in the baseline so a successful re-crawl isn't flagged as an
      // unsaved change. The input state is normalized to the same trimmed
      // value, otherwise stray whitespace would keep `dirty` latched on.
      const crawled = inner.websiteMd;
      const crawledUrl = websiteUrl.trim();
      setWebsiteUrl(crawledUrl);
      setBaseline((prev) => ({ ...prev, websiteMd: crawled, websiteUrl: crawledUrl }));
    }
    if (Array.isArray(inner.pages)) {
      setCrawlReport({
        crawledAt: inner.crawledAt ?? new Date().toISOString(),
        source,
        pages: inner.pages
      });
    }
    setRecrawl({
      status: "success",
      pages: inner.pagesCrawled ?? 0,
      preview: inner.websiteMdPreview ?? ""
    });
    // Any success — crawled or pasted — means the escape hatch is no
    // longer needed; don't leave a stale paste panel open.
    setPasteOpen(false);
    setPastedHtml("");
  }

  async function runIngest(sourceHtml?: string) {
    if (!websiteUrl.trim()) {
      setRecrawl({ status: "error", message: "Enter a website URL first." });
      return;
    }
    setRecrawl({ status: "running", progress: EMPTY_PROGRESS });
    const source = sourceHtml ? ("pasted_html" as const) : ("crawl" as const);
    try {
      const res = await fetch("/api/onboard/website-ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          websiteUrl: websiteUrl.trim(),
          businessName,
          businessType,
          // Ask for the NDJSON progress stream so each crawled page shows
          // up live instead of a bare spinner for the whole deep crawl.
          stream: true,
          ...(sourceHtml ? { pastedHtml: sourceHtml } : {})
        })
      });

      const contentType = res.headers.get("content-type") ?? "";
      if (res.ok && contentType.includes("application/x-ndjson") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let terminal: Record<string, unknown> | null = null;

        const handleLine = (raw: string) => {
          const line = raw.trim();
          if (!line) return;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line) as Record<string, unknown>;
          } catch {
            return; // partial/garbled line — never abort the crawl over it
          }
          if (parsed.kind === "progress") {
            setRecrawl((prev) => {
              const progress = prev.status === "running" ? prev.progress : EMPTY_PROGRESS;
              if (parsed.type === "page_fetched") {
                return {
                  status: "running",
                  progress: {
                    ...progress,
                    fetched: typeof parsed.index === "number" ? parsed.index : progress.fetched + 1,
                    lastUrl: typeof parsed.url === "string" ? parsed.url : progress.lastUrl
                  }
                };
              }
              if (parsed.type === "page_failed") {
                return { status: "running", progress: { ...progress, failed: progress.failed + 1 } };
              }
              if (parsed.type === "sitemap_found") {
                return {
                  status: "running",
                  progress: {
                    ...progress,
                    sitemapCount: typeof parsed.count === "number" ? parsed.count : null
                  }
                };
              }
              if (parsed.type === "summarizing") {
                return { status: "running", progress: { ...progress, summarizing: true } };
              }
              return prev;
            });
            return;
          }
          if (parsed.kind === "result" || parsed.kind === "error") {
            terminal = parsed;
          }
        };

        // NDJSON framing: lines can split across chunks, so buffer and cut
        // on newlines; flush whatever remains when the stream closes.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newlineAt = buffer.indexOf("\n");
          while (newlineAt >= 0) {
            handleLine(buffer.slice(0, newlineAt));
            buffer = buffer.slice(newlineAt + 1);
            newlineAt = buffer.indexOf("\n");
          }
        }
        handleLine(buffer);

        // Read through a cast: `terminal` is mutated inside the handleLine
        // closure, which TS's control-flow narrowing can't see — it still
        // believes the variable holds its initial null.
        const terminalLine = terminal as Record<string, unknown> | null;
        if (!terminalLine) throw new Error("Re-crawl failed");
        if (terminalLine.kind === "error") {
          throw new Error(
            typeof terminalLine.message === "string" ? terminalLine.message : "Re-crawl failed"
          );
        }
        applyIngestResult(terminalLine as unknown as IngestResultLine, source);
        return;
      }

      // Non-streaming response: auth/validation failures (and any server
      // that ignores the stream flag) answer with the plain JSON envelope.
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; data?: IngestResultLine; error?: { message?: string } }
        | null;
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error?.message ?? "Re-crawl failed");
      }
      applyIngestResult(json.data ?? {}, source);
    } catch (err) {
      setRecrawl({
        status: "error",
        message: err instanceof Error ? err.message : "Re-crawl failed"
      });
      setPasteOpen(true);
    }
  }

  async function handleRecrawl() {
    await runIngest();
  }

  async function handleSummarizePasted() {
    if (!pastedHtml.trim()) {
      setRecrawl({ status: "error", message: "Paste your page source first." });
      return;
    }
    await runIngest(pastedHtml);
  }

  return (
    <div className="space-y-5">
      {starterBudget?.overBudget && (
        <p className="text-sm text-amber-200/90 border border-amber-500/40 rounded-lg px-3 py-2 bg-amber-950/30">
          Starter tier: combined Soul + Identity + Memory + Website is large (~{starterBudget.estimatedTotal}{" "}
          estimated tokens vs ~{starterBudget.maxTokens} target). Very long vault text can slow responses on
          your coworker&apos;s KVM2 instance; consider trimming less-used detail or re-crawling a shorter
          landing page.
        </p>
      )}
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
      <Card>
        <h3 className="text-sm font-semibold text-parchment mb-3 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-claw-green" />
          Soul (Personality &amp; Ethics)
        </h3>
        <Textarea
          value={soul}
          onChange={(e) => {
            setSoul(e.target.value);
            clearSaveError();
          }}
          rows={6}
          placeholder="Core personality, ethics, and communication style..."
        />
        <p className="mt-2 text-xs text-parchment/40">
          {soul.length.toLocaleString()} / {BUSINESS_CONFIG_SOUL_MD_MAX_CHARS.toLocaleString()} characters
        </p>
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-parchment mb-3 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-claw-green" />
          Identity (Business Facts)
        </h3>
        <Textarea
          value={identity}
          onChange={(e) => {
            setIdentity(e.target.value);
            clearSaveError();
          }}
          rows={6}
          placeholder="Business name, market, services, team info..."
        />
        <p className="mt-2 text-xs text-parchment/40">
          {identity.length.toLocaleString()} / {BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS.toLocaleString()}{" "}
          characters
        </p>
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-parchment mb-3 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-claw-green" />
          Memory (Learned Facts)
        </h3>
        <Textarea
          value={memory}
          onChange={(e) => {
            setMemory(e.target.value);
            clearSaveError();
          }}
          rows={8}
          placeholder="Accumulated business knowledge..."
        />
        <p className="mt-2 text-xs text-parchment/40">
          {memory.length.toLocaleString()} / {BUSINESS_CONFIG_MEMORY_MD_MAX_CHARS.toLocaleString()} characters
        </p>
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
        {!pasteOpen && (
          <button
            type="button"
            onClick={() => setPasteOpen(true)}
            className="mt-2 text-xs text-parchment/40 underline underline-offset-2 hover:text-parchment/70"
          >
            Site blocks crawlers? Paste your page source instead
          </button>
        )}
        {recrawl.status === "running" && (
          <div className="mt-2 text-xs text-parchment/60 space-y-0.5">
            {recrawl.progress.summarizing ? (
              <p>
                Summarizing {recrawl.progress.fetched} page
                {recrawl.progress.fetched === 1 ? "" : "s"}…
              </p>
            ) : recrawl.progress.fetched > 0 ? (
              <p>
                Crawling… {recrawl.progress.fetched} page
                {recrawl.progress.fetched === 1 ? "" : "s"} read
                {recrawl.progress.sitemapCount
                  ? ` (${recrawl.progress.sitemapCount} found in sitemap)`
                  : ""}
              </p>
            ) : (
              <p>Contacting your site…</p>
            )}
            {!recrawl.progress.summarizing && recrawl.progress.lastUrl && (
              <p className="truncate text-parchment/40 font-mono">
                {crawlPathLabel(recrawl.progress.lastUrl)}
              </p>
            )}
          </div>
        )}
        {recrawl.status === "success" && (
          <p className="mt-2 text-xs text-claw-green">
            Refreshed from {recrawl.pages} page{recrawl.pages === 1 ? "" : "s"}.
          </p>
        )}
        {recrawl.status === "error" && (
          <p className="mt-2 text-xs text-rose-300">{recrawl.message}</p>
        )}
        {crawlReport && crawlReport.pages.length > 0 && recrawl.status !== "running" && (
          <details className="mt-2 text-xs text-parchment/50">
            <summary className="cursor-pointer select-none hover:text-parchment/70">
              Last crawl: {crawlReport.pages.length} page{crawlReport.pages.length === 1 ? "" : "s"}
              {crawlReport.source === "pasted_html" ? " (from pasted source)" : ""} on{" "}
              {new Date(crawlReport.crawledAt).toLocaleString()}
            </summary>
            <ul className="mt-1 max-h-40 overflow-y-auto space-y-0.5 rounded-lg border border-parchment/10 bg-ink/40 p-2 font-mono">
              {crawlReport.pages.map((page, i) => (
                // Redirect-followed pages can share a final URL, so the key
                // includes the position.
                <li key={`${i}-${page.url}`} className="truncate text-parchment/40">
                  {crawlPathLabel(page.url)}
                </li>
              ))}
            </ul>
          </details>
        )}
        {pasteOpen && (
          <div className="mt-3 rounded-lg border border-parchment/15 bg-ink/40 p-3">
            <p className="text-xs text-parchment/60">
              Site blocking our crawler? Open your homepage in a new tab, right-click →{" "}
              <span className="text-parchment/80">View Page Source</span>, select all, copy, and
              paste it here. We&apos;ll extract and summarize it exactly like a normal crawl.
            </p>
            <div className="mt-2">
              <Textarea
                value={pastedHtml}
                onChange={(e) => setPastedHtml(e.target.value)}
                rows={6}
                placeholder="<!DOCTYPE html>… paste your homepage's page source here"
              />
            </div>
            <div className="mt-2 flex items-center gap-3">
              <Button
                onClick={handleSummarizePasted}
                loading={recrawl.status === "running"}
                variant="secondary"
              >
                Summarize pasted source
              </Button>
              <button
                type="button"
                onClick={() => setPasteOpen(false)}
                className="text-xs text-parchment/40 hover:text-parchment/70"
              >
                Hide
              </button>
            </div>
          </div>
        )}
        <div className="mt-3">
          <Textarea
            value={websiteMd}
            onChange={(e) => {
              setWebsiteMd(e.target.value);
              clearSaveError();
            }}
            rows={10}
            placeholder="Website summary (markdown). Regenerated when you re-crawl; edits above can be kept if you don't re-crawl."
          />
          <p className="mt-2 text-xs text-parchment/40">
            {websiteMd.length.toLocaleString()} / {BUSINESS_CONFIG_WEBSITE_MD_MAX_CHARS.toLocaleString()}{" "}
            characters
          </p>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} loading={saving} disabled={Boolean(charLimitIssue)}>
          Save Changes
        </Button>
        {saved && <span className="text-sm text-claw-green">✓ Saved</span>}
        {dirty && !saving && (
          <span className="text-sm text-amber-300/80">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}
