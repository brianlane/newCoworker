"use client";

/**
 * Interactive walkthrough for /dashboard/aiflows/guides/instagram-leads.
 *
 * Personalized like the Meta-leads guide: shows THIS tenant's endpoint URL
 * with a copy button, installs the "Instagram prospect intake" starter flow
 * with one click (POST /api/aiflows, created disabled for review), mints the
 * `nck_` API key inline, and renders a live "recent webhook events" readout.
 *
 * Two ingest paths, both already served by shipped infrastructure:
 *   - LIVE BRIDGE: an Instagram scraping tool (Apify etc.) → Make.com/Zapier
 *     → POST /api/public/v1/flow-events with source "instagram_scraper".
 *   - BATCH IMPORT: a scraper's CSV export → /dashboard/aiflows/import-leads
 *     with the same source label — each row rides the identical webhook path.
 *
 * Compliance is front and center: scraped prospects never consented (TCPA /
 * CAN-SPAM), so the starter flow files + tags them for owner review and
 * NEVER texts or emails them.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  instagramProspectTemplate,
  INSTAGRAM_PROSPECT_TAG,
  INSTAGRAM_SCRAPER_SOURCE
} from "@/lib/ai-flows/templates";

type WebhookFlowItem = { id: string; name: string; enabled: boolean };

type RecentEventItem = {
  id: number;
  createdAt: string;
  source: string;
  runsEnqueued: number;
  /** Flows whose conditions matched (a retry can match yet enqueue 0 new runs). */
  flowsMatched: number;
  preview: string;
};

type Props = {
  businessId: string;
  endpointUrl: string;
  hasApiKey: boolean;
  webhookFlows: WebhookFlowItem[];
  recentEvents: RecentEventItem[];
};

function StepHeading({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-signal-teal/15 text-sm font-semibold text-signal-teal">
        {n}
      </span>
      <h2 className="text-base font-semibold text-parchment">{title}</h2>
    </div>
  );
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 min-w-0 break-all rounded bg-deep-ink/60 px-2 py-1.5 font-mono text-xs text-signal-teal select-all">
        {value}
      </code>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            // Clipboard can be denied; the value is selectable text either way.
          }
        }}
        aria-label={`Copy ${label}`}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export function InstagramLeadsGuide({
  businessId,
  endpointUrl,
  hasApiKey,
  webhookFlows,
  recentEvents
}: Props) {
  const router = useRouter();
  const [installing, setInstalling] = useState(false);
  const [installedFlowId, setInstalledFlowId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const template = instagramProspectTemplate();
  // Only a flow that IS this starter counts as installed — a tenant with some
  // other webhook flow still gets the one-click install (same rule as the
  // Meta-leads guide, Bugbot fe7aebd1).
  const existingFlow = webhookFlows.find((f) => f.name === template.name) ?? null;
  const otherWebhookFlow = existingFlow ? null : (webhookFlows[0] ?? null);

  async function installFlow() {
    setInstallError(null);
    setInstalling(true);
    try {
      const res = await fetch("/api/aiflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          name: template.name,
          enabled: false,
          definition: template.definition
        })
      });
      const json = (await res.json()) as
        | { ok: true; data: { id: string } }
        | { ok: false; error: { message: string } };
      if (!json.ok) {
        setInstallError(json.error.message);
        return;
      }
      setInstalledFlowId(json.data.id);
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setInstalling(false);
    }
  }

  async function mintKey() {
    setMintError(null);
    setMinting(true);
    try {
      const res = await fetch("/api/dashboard/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, name: "Instagram leads bridge" })
      });
      const json = (await res.json()) as
        | { ok: true; data: { plaintext: string } }
        | { ok: false; error: { message: string } };
      if (!json.ok) {
        setMintError(json.error.message);
        return;
      }
      setFreshKey(json.data.plaintext);
    } catch (err) {
      setMintError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setMinting(false);
    }
  }

  function refreshEvents() {
    setRefreshing(true);
    router.refresh();
    // router.refresh() has no completion callback; re-enable shortly after the
    // server components re-render so the button never sticks disabled.
    setTimeout(() => setRefreshing(false), 1500);
  }

  return (
    <div className="space-y-6">
      {/* ── Read this first: consent & platform-terms reality check ────── */}
      <Card>
        <div className="rounded-md border border-spark-orange/40 bg-spark-orange/5 p-3">
          <h2 className="text-base font-semibold text-parchment">
            Read this first: prospecting rules
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-parchment/70">
            <li>
              <strong>Scraped prospects never consented.</strong> U.S. law requires prior
              express written consent before marketing texts (TCPA), and marketing email to
              scraped addresses invites spam complaints (CAN-SPAM). The starter flow below
              deliberately <strong>never texts or emails</strong> — it files each prospect
              tagged <code className="font-mono text-xs">{INSTAGRAM_PROSPECT_TAG}</code> for
              you to review and reach out personally.
            </li>
            <li>
              <strong>Scraping tools are third-party.</strong> Automated scraping is against
              Instagram&apos;s terms; accounts you run scrapers with can be restricted. You
              choose and operate the tool — we just receive what it sends.
            </li>
            <li>
              <strong>Running Instagram or Facebook ads?</strong> Ad leads gave you their
              details on purpose — use the{" "}
              <Link
                href="/dashboard/aiflows/guides/meta-leads"
                className="text-signal-teal hover:underline"
              >
                Meta ad leads guide
              </Link>{" "}
              instead; those leads can be texted back immediately.
            </li>
          </ul>
        </div>
      </Card>

      {/* ── Step 1: install the flow ─────────────────────────────────── */}
      <Card>
        <StepHeading n={1} title="Install the prospect intake flow" />
        <p className="mt-2 text-sm text-parchment/60">
          One click adds a ready-made AiFlow: when a prospect arrives (live bridge or CSV
          import), your coworker reads out the name, phone, email, and Instagram handle,
          files them in your customers tagged{" "}
          <code className="font-mono text-xs">{INSTAGRAM_PROSPECT_TAG}</code>, and sends you
          a summary. It never contacts the prospect. It installs <em>paused</em> so you can
          review it first.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {installedFlowId || existingFlow ? (
            <>
              <span className="text-sm text-signal-teal">
                {installedFlowId ? "Installed." : `You already have “${existingFlow?.name}”.`}
              </span>
              <Link
                href={`/dashboard/aiflows?edit=${installedFlowId ?? existingFlow?.id}`}
                className="text-sm text-signal-teal hover:underline"
              >
                Review &amp; enable it →
              </Link>
            </>
          ) : (
            <>
              <Button type="button" variant="primary" size="sm" onClick={installFlow} loading={installing}>
                Install “{template.name}”
              </Button>
              {otherWebhookFlow ? (
                <span className="text-xs text-parchment/50">
                  Your existing webhook flow “{otherWebhookFlow.name}” keeps working — this
                  adds a separate starter for Instagram prospects.
                </span>
              ) : null}
            </>
          )}
        </div>
        {installError ? (
          <p className="mt-2 text-xs text-spark-orange" role="alert">
            {installError}
          </p>
        ) : null}
      </Card>

      {/* ── Path A: import a CSV export ──────────────────────────────── */}
      <Card>
        <div className="rounded-md border border-signal-teal/40 bg-signal-teal/5 p-3">
          <StepHeading n={2} title="Fastest path: import your scraper's CSV export" />
          <p className="mt-2 text-sm text-parchment/70">
            Most scraping tools (PhantomBuster, IGLeads, Apify) export results as a
            spreadsheet. Upload it on the{" "}
            <Link
              href="/dashboard/aiflows/import-leads"
              className="text-signal-teal hover:underline"
            >
              Import leads page
            </Link>{" "}
            and set the <strong>source label</strong> to{" "}
            <code className="font-mono text-xs">{INSTAGRAM_SCRAPER_SOURCE}</code> — each row
            then triggers the flow from step 1 exactly like a live delivery, drip-paced so a
            big list lands gradually. No bridge, no API key needed.
          </p>
        </div>
      </Card>

      {/* ── Path B: the live bridge ──────────────────────────────────── */}
      <Card>
        <StepHeading n={3} title="Live path: create your connection key" />
        <p className="mt-2 text-sm text-parchment/60">
          Running scrapes on a schedule? A bridge can deliver every result the moment a run
          finishes. The bridge proves it&apos;s yours with an API key — create one here.
          It&apos;s shown once, so copy it somewhere safe before you leave this page.
        </p>
        {freshKey ? (
          <div className="mt-3 rounded-md border border-signal-teal/40 bg-signal-teal/5 p-3 space-y-2">
            <p className="text-xs text-parchment/80">
              Your key is ready — copy it now, it won&apos;t be shown again:
            </p>
            <CopyField value={freshKey} label="API key" />
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="button" variant="primary" size="sm" onClick={mintKey} loading={minting}>
              Create API key
            </Button>
            {hasApiKey ? (
              <span className="text-xs text-parchment/50">
                You already have a key. Reuse it if you saved it, or manage keys on the{" "}
                <Link
                  href="/dashboard/integrations/zapier-api"
                  className="text-signal-teal hover:underline"
                >
                  Zapier &amp; API page
                </Link>
                .
              </span>
            ) : null}
          </div>
        )}
        {mintError ? (
          <p className="mt-2 text-xs text-spark-orange" role="alert">
            {mintError}
          </p>
        ) : null}
      </Card>

      <Card>
        <StepHeading n={4} title="Live path: connect your scraper via Make.com (free)" />
        <p className="mt-2 text-sm text-parchment/60">
          Scraping tools don&apos;t talk to your coworker directly, so a small bridge
          forwards each result. Make.com&apos;s free plan covers this. The steps below use
          Apify (the most common scraper marketplace); any tool that can call a webhook or
          run in Make works the same way.
        </p>
        <div className="mt-3 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-parchment/40">
            Your webhook address (used below)
          </p>
          <CopyField value={endpointUrl} label="webhook address" />
        </div>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-parchment/70">
          <li>
            Create a free account at{" "}
            <a
              href="https://www.make.com"
              target="_blank"
              rel="noreferrer"
              className="text-signal-teal hover:underline"
            >
              make.com
            </a>{" "}
            and click <strong>Create a new scenario</strong>.
          </li>
          <li>
            First module: search for <strong>Apify</strong>, pick{" "}
            <strong>“Watch Actor Runs”</strong>, connect your Apify account, and choose the
            Instagram scraper Actor you use. Add a second Apify module,{" "}
            <strong>“Get Dataset Items”</strong>, so each finished run hands you the scraped
            profiles.
          </li>
          <li>
            Last module: search for <strong>HTTP</strong>, pick <strong>“Make a request”</strong>,
            and fill in:
            <ul className="mt-1 list-disc space-y-1 pl-5 text-parchment/60">
              <li>
                <strong>URL:</strong> paste your webhook address from above;{" "}
                <strong>Method:</strong> POST
              </li>
              <li>
                <strong>Headers:</strong> add one named{" "}
                <code className="font-mono text-xs">Authorization</code> with the value{" "}
                <code className="font-mono text-xs">Bearer YOUR-API-KEY</code> (the key from
                step 3, after the word “Bearer” and a space)
              </li>
              <li>
                <strong>Body type:</strong> Raw, <strong>Content type:</strong> JSON. In the
                request content, build:{" "}
                <code className="block mt-1 whitespace-pre-wrap break-all rounded bg-deep-ink/60 p-2 font-mono text-[11px] text-parchment/70">
                  {`{"source": "${INSTAGRAM_SCRAPER_SOURCE}", "event_id": "{{username}}", "data": {"full_name": "{{fullName}}", "username": "{{username}}", "email": "{{email}}", "phone_number": "{{phone}}", "bio": "{{biography}}", "followers": "{{followersCount}}"}}`}
                </code>
                <span className="text-xs">
                  — clicking into each {"{{…}}"} spot lets you pick the matching field from
                  the Apify dataset. Keep{" "}
                  <code className="font-mono text-[11px]">source</code> exactly as shown — the
                  flow from step 1 only fires for it. The{" "}
                  <code className="font-mono text-[11px]">event_id</code> makes redeliveries
                  of the same profile land only once.
                </span>
              </li>
            </ul>
          </li>
          <li>Turn the scenario ON (the toggle in the bottom-left).</li>
        </ol>
        <div className="mt-4 rounded-md border border-parchment/10 bg-deep-ink/20 p-3">
          <p className="text-xs text-parchment/60">
            <strong>Tool sends webhooks directly?</strong> Some scraping tools (including
            Apify itself, under Actor → Integrations → Add webhook) can POST run results to
            a URL without Make. Point them at your webhook address with the same{" "}
            <code className="font-mono text-[11px]">Authorization</code> header and JSON
            shape — one request per prospect.
          </p>
        </div>
      </Card>

      {/* ── Step 5: test it ──────────────────────────────────────────── */}
      <Card>
        <StepHeading n={5} title="Send a test and watch it arrive" />
        <p className="mt-2 text-sm text-parchment/60">
          Run your scenario once in Make (the “Run once” button), or import a two-row CSV on
          the Import leads page. Within seconds each prospect should show up right here:
        </p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-parchment/40">
            Recent webhook events
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={refreshEvents} loading={refreshing}>
            Refresh
          </Button>
        </div>
        {recentEvents.length === 0 ? (
          <p className="mt-2 rounded-md border border-dashed border-parchment/15 p-4 text-center text-xs text-parchment/45">
            Nothing yet — events appear here the moment your bridge or import delivers one.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-parchment/10">
            {recentEvents.map((e) => (
              <li key={e.id} className="py-2.5">
                <div className="flex items-center gap-2 text-xs">
                  <span className="rounded border border-parchment/15 px-1 py-0.5 text-[10px] uppercase tracking-wider text-parchment/45">
                    {e.source}
                  </span>
                  <span className="text-parchment/45">
                    {new Date(e.createdAt).toLocaleString()}
                  </span>
                  <span
                    className={e.flowsMatched > 0 ? "text-signal-teal" : "text-parchment/45"}
                  >
                    {e.runsEnqueued > 0
                      ? `started ${e.runsEnqueued} flow run${e.runsEnqueued > 1 ? "s" : ""}`
                      : e.flowsMatched > 0
                        ? "already handled (repeat delivery of the same prospect)"
                        : "no flow matched (is your flow enabled?)"}
                  </span>
                </div>
                {e.preview ? (
                  <p className="mt-1 truncate font-mono text-[11px] text-parchment/50">{e.preview}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-parchment/50">
          Once a test shows a started flow run, check{" "}
          <Link href="/dashboard/aiflows/runs" className="text-signal-teal hover:underline">
            View runs
          </Link>{" "}
          for the full play-by-play, then find the filed prospects on your{" "}
          <Link href="/dashboard/customers" className="text-signal-teal hover:underline">
            Contacts page
          </Link>{" "}
          under the <code className="font-mono text-[11px]">{INSTAGRAM_PROSPECT_TAG}</code>{" "}
          tag — and reach out on your own terms.
        </p>
      </Card>
    </div>
  );
}
