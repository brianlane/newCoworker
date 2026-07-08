"use client";

/**
 * Interactive walkthrough for /dashboard/aiflows/guides/meta-leads.
 *
 * Personalized (never generic prose): shows THIS tenant's endpoint URL with a
 * copy button, installs the "Meta lead follow-up" starter flow with one click
 * (POST /api/aiflows, created disabled for review), mints the `nck_` API key
 * inline (same endpoint the integrations card uses; plaintext shown once),
 * and renders a live "recent webhook events" readout so the owner SEES their
 * Meta test lead arrive. Bridge steps lead with Make.com (free tier); Zapier
 * is the alternative for owners who already pay for it.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { metaLeadFollowUpTemplate } from "@/lib/ai-flows/templates";

type WebhookFlowItem = { id: string; name: string; enabled: boolean };

type RecentEventItem = {
  id: number;
  createdAt: string;
  source: string;
  runsEnqueued: number;
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

export function MetaLeadsGuide({
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

  const template = metaLeadFollowUpTemplate();
  const existingFlow = webhookFlows[0] ?? null;

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
        body: JSON.stringify({ businessId, name: "Meta leads bridge" })
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
      {/* ── Step 1: install the flow ─────────────────────────────────── */}
      <Card>
        <StepHeading n={1} title="Install the lead follow-up flow" />
        <p className="mt-2 text-sm text-parchment/60">
          One click adds a ready-made AiFlow: when a lead arrives, your coworker reads out the
          name, phone, and email, files them in your customers, texts them a hello within
          seconds, and sends you a summary. It installs <em>paused</em> so you can review (and
          reword) the text message first.
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
            <Button type="button" variant="primary" size="sm" onClick={installFlow} loading={installing}>
              Install “{template.name}”
            </Button>
          )}
        </div>
        {installError ? (
          <p className="mt-2 text-xs text-spark-orange" role="alert">
            {installError}
          </p>
        ) : null}
      </Card>

      {/* ── Step 2: API key ──────────────────────────────────────────── */}
      <Card>
        <StepHeading n={2} title="Create your connection key" />
        <p className="mt-2 text-sm text-parchment/60">
          The bridge tool (next step) proves it&apos;s yours with an API key. Create one here —
          it&apos;s shown once, so copy it somewhere safe before you leave this page.
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
                <Link href="/dashboard/integrations" className="text-signal-teal hover:underline">
                  Integrations page
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

      {/* ── Step 3: the bridge ───────────────────────────────────────── */}
      <Card>
        <StepHeading n={3} title="Connect Facebook to your coworker (via Make.com — free)" />
        <p className="mt-2 text-sm text-parchment/60">
          Meta only hands leads to approved partners, so a small bridge forwards each new lead
          to your coworker the moment it&apos;s submitted. Make.com&apos;s free plan covers this
          (1,000 leads/month). You&apos;ll need to be an <strong>admin of your Facebook Page</strong>.
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
            First module: search for <strong>Facebook Lead Ads</strong>, pick{" "}
            <strong>“Watch Leads” (instant)</strong>, log into Facebook, and choose your Page and
            lead form.
          </li>
          <li>
            Second module: search for <strong>HTTP</strong>, pick <strong>“Make a request”</strong>,
            and fill in:
            <ul className="mt-1 list-disc space-y-1 pl-5 text-parchment/60">
              <li>
                <strong>URL:</strong> paste your webhook address from above; <strong>Method:</strong>{" "}
                POST
              </li>
              <li>
                <strong>Headers:</strong> add one named <code className="font-mono text-xs">Authorization</code>{" "}
                with the value <code className="font-mono text-xs">Bearer YOUR-API-KEY</code> (the key
                from step 2, after the word “Bearer” and a space)
              </li>
              <li>
                <strong>Body type:</strong> Raw, <strong>Content type:</strong> JSON. In the request
                content, build:{" "}
                <code className="block mt-1 whitespace-pre-wrap break-all rounded bg-deep-ink/60 p-2 font-mono text-[11px] text-parchment/70">
                  {`{"source": "facebook_lead_ads", "event_id": "{{Lead ID}}", "data": {"full_name": "{{Full name}}", "phone_number": "{{Phone number}}", "email": "{{Email}}"}}`}
                </code>
                <span className="text-xs">
                  — clicking into each {"{{…}}"} spot lets you pick the matching lead field from the
                  Facebook module. Add any custom form questions the same way.
                </span>
              </li>
            </ul>
          </li>
          <li>Turn the scenario ON (the toggle in the bottom-left).</li>
        </ol>
        <div className="mt-4 rounded-md border border-parchment/10 bg-deep-ink/20 p-3">
          <p className="text-xs text-parchment/60">
            <strong>Already pay for Zapier?</strong> Use it instead: trigger{" "}
            <em>Facebook Lead Ads → New Lead</em>, action{" "}
            <em>NewCoworker → Send Lead to Coworker</em> (connect with the same API key, map the
            lead fields — no URL or headers needed). Note Facebook Lead Ads is a premium Zapier
            app and needs a paid Zapier plan; Make.com&apos;s free tier is why we recommend it.
          </p>
        </div>
      </Card>

      {/* ── Step 4: the CRM-access gotcha ────────────────────────────── */}
      <Card>
        <div className="rounded-md border border-spark-orange/40 bg-spark-orange/5 p-3">
          <StepHeading n={4} title="Don't skip: grant the bridge Lead Access in Facebook" />
          <p className="mt-2 text-sm text-parchment/70">
            This is the #1 reason lead capture <em>silently</em> fails: test leads work, then real
            ad leads never arrive. In{" "}
            <strong>
              Facebook Business Settings → Integrations → Lead Access
            </strong>
            , make sure your bridge (Make or Zapier) is listed with CRM access for your Page — if
            it isn&apos;t, click <strong>Add CRMs</strong> and add it.
          </p>
        </div>
      </Card>

      {/* ── Step 5: test it ──────────────────────────────────────────── */}
      <Card>
        <StepHeading n={5} title="Send a test lead and watch it arrive" />
        <p className="mt-2 text-sm text-parchment/60">
          Use Meta&apos;s{" "}
          <a
            href="https://developers.facebook.com/tools/lead-ads-testing"
            target="_blank"
            rel="noreferrer"
            className="text-signal-teal hover:underline"
          >
            Lead Ads Testing Tool
          </a>{" "}
          to submit a fake lead against your form. Within seconds it should show up right here:
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
            Nothing yet — events appear here the moment your bridge delivers one.
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
                  <span className={e.runsEnqueued > 0 ? "text-signal-teal" : "text-parchment/45"}>
                    {e.runsEnqueued > 0
                      ? `started ${e.runsEnqueued} flow run${e.runsEnqueued > 1 ? "s" : ""}`
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
          Once the test lead shows a started flow run, check{" "}
          <Link href="/dashboard/aiflows/runs" className="text-signal-teal hover:underline">
            View runs
          </Link>{" "}
          for the full play-by-play. From here on, every real ad lead is handled automatically.
        </p>
      </Card>
    </div>
  );
}
