"use client";

import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";

/**
 * Settings card for the embeddable website chat widget (Standard+).
 *
 * Renders the enable toggle, the copyable embed snippet, allowed-origins
 * list, pre-chat contact-form toggle, and theming knobs. Starter tenants
 * get an upgrade note instead (the API enforces the tier server-side; this
 * is just honest UI). All writes go through POST /api/dashboard/widget.
 */

export type WebchatWidgetSettingsData = {
  enabled: boolean;
  publicKey: string;
  allowedOrigins: string[];
  requireContactForm: boolean;
  theme: {
    accentColor?: string;
    greeting?: string;
    agentDisplayName?: string;
  } | null;
};

export function WebchatWidgetSettings({
  businessId,
  tierAllowed,
  initialSettings
}: {
  businessId: string;
  tierAllowed: boolean;
  initialSettings: WebchatWidgetSettingsData | null;
}) {
  const [settings, setSettings] = useState<WebchatWidgetSettingsData | null>(initialSettings);
  const [origins, setOrigins] = useState((initialSettings?.allowedOrigins ?? []).join("\n"));
  const [accent, setAccent] = useState(initialSettings?.theme?.accentColor ?? "");
  const [greeting, setGreeting] = useState(initialSettings?.theme?.greeting ?? "");
  const [agentName, setAgentName] = useState(initialSettings?.theme?.agentDisplayName ?? "");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/dashboard/widget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, ...body })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { settings: WebchatWidgetSettingsData };
        error?: { message: string };
      };
      if (!json.ok || !json.data) throw new Error(json.error?.message ?? "Save failed");
      setSettings(json.data.settings);
      setStatus("Saved.");
      return json.data.settings;
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Save failed");
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (!tierAllowed) {
    return (
      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-2">Website chat widget</h2>
        <p className="text-xs text-parchment/40">
          Put your coworker on your own website: visitors get instant answers about your
          business, and every conversation captures a lead. Available on Standard and
          Enterprise plans.
        </p>
        <a href="/pricing" className="mt-4 inline-block text-sm text-claw-green hover:underline">
          Upgrade to Standard →
        </a>
      </Card>
    );
  }

  const snippet = settings
    ? `<script src="${typeof window !== "undefined" ? window.location.origin : ""}/widget.js" data-key="${settings.publicKey}" async></script>`
    : "";

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setStatus("Copy failed — select the snippet and copy manually.");
    }
  };

  // The full form state as a POST payload. Every write — including the
  // enable / pre-chat-form toggles — sends it, so what the owner SEES in
  // the origins/theme fields is always what gets persisted (a toggle can
  // never silently enable the widget under a stale allowlist).
  const configPayload = () => {
    const theme: Record<string, string> = {};
    if (accent.trim()) theme.accentColor = accent.trim();
    if (greeting.trim()) theme.greeting = greeting.trim();
    if (agentName.trim()) theme.agentDisplayName = agentName.trim();
    return {
      allowedOrigins: origins
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      theme: Object.keys(theme).length > 0 ? theme : null
    };
  };

  const saveConfig = async () => {
    await post(configPayload());
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-parchment">Website chat widget</h2>
        {settings && (
          <label className="flex items-center gap-2 text-xs text-parchment/70">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={busy}
              onChange={(ev) =>
                // Enabling persists the WHOLE form so the widget can't go
                // live under a stale allowlist/theme. Disabling stays a pure
                // { enabled: false } — the API allows that on ANY tier, so a
                // downgraded tenant can always turn the widget off.
                post(
                  ev.target.checked
                    ? { ...configPayload(), enabled: true }
                    : { enabled: false }
                )
              }
            />
            Enabled
          </label>
        )}
      </div>
      <p className="text-xs text-parchment/40 mb-4">
        Add your coworker to your own website as a chat bubble. It answers visitor questions
        from your business knowledge and captures leads — it can&apos;t send texts or emails
        or place calls from this surface.
      </p>

      {!settings ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => post({ enabled: false })}
          className="text-sm text-claw-green hover:underline"
        >
          Set up the widget →
        </button>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-xs text-parchment/50 mb-1">
              Paste this once into your website&apos;s HTML (before <code>&lt;/body&gt;</code>):
            </p>
            <div className="flex items-start gap-2">
              <pre className="flex-1 text-[11px] leading-relaxed bg-black/30 border border-parchment/10 rounded-lg p-3 overflow-x-auto text-parchment/80 whitespace-pre-wrap break-all">
                {snippet}
              </pre>
              <button
                type="button"
                onClick={copySnippet}
                className="text-xs text-claw-green hover:underline shrink-0 mt-1"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          <label className="block text-xs text-parchment/70">
            Allowed websites (one per line; empty = any site)
            <textarea
              value={origins}
              onChange={(ev) => setOrigins(ev.target.value)}
              rows={2}
              placeholder={"https://example.com"}
              className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/10 p-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green"
            />
          </label>

          <label className="flex items-start gap-3 text-sm text-parchment/80">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={settings.requireContactForm}
              disabled={busy}
              onChange={(ev) => post({ ...configPayload(), requireContactForm: ev.target.checked })}
            />
            <span>
              Ask for name and email/phone before chatting
              <span className="block text-xs text-parchment/40 mt-1">
                When off, visitors chat right away and your coworker asks for contact details
                naturally during the conversation.
              </span>
            </span>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block text-xs text-parchment/70">
              Accent color
              <input
                type="text"
                value={accent}
                onChange={(ev) => setAccent(ev.target.value)}
                placeholder="#0f172a"
                className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/10 p-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green"
              />
            </label>
            <label className="block text-xs text-parchment/70">
              Assistant name
              <input
                type="text"
                value={agentName}
                onChange={(ev) => setAgentName(ev.target.value)}
                maxLength={60}
                placeholder="Acme assistant"
                className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/10 p-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green"
              />
            </label>
            <label className="block text-xs text-parchment/70">
              Greeting
              <input
                type="text"
                value={greeting}
                onChange={(ev) => setGreeting(ev.target.value)}
                maxLength={300}
                placeholder="Hi! How can I help?"
                className="mt-1 w-full rounded-lg bg-black/30 border border-parchment/10 p-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green"
              />
            </label>
          </div>

          <div className="flex items-center gap-4">
            <button
              type="button"
              disabled={busy}
              onClick={saveConfig}
              className="rounded-lg bg-claw-green text-deep-ink px-4 py-2 text-sm font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50"
            >
              Save widget settings
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Generate a new key? The current embed snippet stops working until you paste the new one into your site."
                  )
                ) {
                  void post({ regenerateKey: true });
                }
              }}
              className="text-xs text-spark-orange hover:underline"
            >
              Regenerate key
            </button>
            <Link
              href="/dashboard/webchat"
              className="text-xs text-claw-green hover:underline ml-auto"
            >
              View conversations →
            </Link>
          </div>
        </div>
      )}
      {status && <p className="mt-3 text-xs text-parchment/50">{status}</p>}
    </Card>
  );
}
