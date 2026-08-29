"use client";

/**
 * Telegram bot connection card for /dashboard/integrations.
 *
 * WHY THIS ASKS FOR A TOKEN when no other card in here does. Telegram has
 * no OAuth, and the only alternative was one shared platform bot for every
 * tenant. Slack, Teams and Google Chat all hand us an organisation id on
 * every inbound event, so a shared app still has a platform-enforced
 * boundary between tenants; Telegram has no concept of an organisation, so
 * a shared bot would put every tenant's owner in one DM pool separated only
 * by our own bookkeeping. A bot per tenant restores that boundary, and it
 * carries the business's own name and picture.
 *
 * The token is verified with Telegram before it is stored, so a typo fails
 * here rather than silently at the first alert, and the server registers
 * the webhook so the owner never touches it again.
 *
 * API contract (/api/integrations/telegram):
 *   GET    ?businessId=…                     → { connection, allowedForTier }
 *   POST   {businessId, botToken}            → verify + store + setWebhook
 *   PATCH  {businessId, alertChatId}         → save the alerts chat
 *   PATCH  {businessId, isActive}            → pause / resume
 *   PATCH  {businessId, mintLinkCodeFor}     → one-time connect code
 *   DELETE ?businessId=…                     → unregister + forget
 *
 * Standard+ only; the routes enforce the same gate server-side.
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type TelegramConnection = {
  id: string;
  business_id: string;
  external_workspace_id: string;
  external_workspace_name: string | null;
  alert_target_id: string | null;
  alert_target_name: string | null;
  is_active: boolean;
};

export function TelegramIntegrationCard({
  businessId,
  initialConnection,
  tierAllowed
}: {
  businessId: string;
  initialConnection: TelegramConnection | null;
  tierAllowed: boolean;
}) {
  const [connection, setConnection] = useState<TelegramConnection | null>(initialConnection);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [linkCode, setLinkCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setConnection(initialConnection);
  }, [initialConnection]);

  const call = useCallback(
    async (init: RequestInit & { method: string }, query = "") => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(`/api/integrations/telegram${query}`, {
          headers: { "Content-Type": "application/json" },
          ...init
        });
        const body = (await res.json().catch(() => null)) as {
          data?: { connection?: TelegramConnection | null; linkCode?: typeof linkCode };
          error?: { message?: string };
        } | null;
        if (!res.ok) {
          setError(body?.error?.message ?? "Something went wrong. Try again.");
          return null;
        }
        return body?.data ?? {};
      } catch {
        setError("Could not reach the server. Try again.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  async function connect() {
    const data = await call({
      method: "POST",
      body: JSON.stringify({ businessId, botToken: botToken.trim() })
    });
    if (!data) return;
    setConnection(data.connection ?? null);
    // Never keep the token in component state after it is stored.
    setBotToken("");
    setNotice("Connected. Now message your bot from Telegram so it can reach you.");
  }

  async function saveAlertChat() {
    const data = await call({
      method: "PATCH",
      body: JSON.stringify({ businessId, alertChatId: chatId.trim() })
    });
    if (!data) return;
    setConnection(data.connection ?? null);
    setChatId("");
    setNotice("Saved. A test message just went to that chat.");
  }

  async function setActive(isActive: boolean) {
    const data = await call({ method: "PATCH", body: JSON.stringify({ businessId, isActive }) });
    if (data) setConnection(data.connection ?? null);
  }

  async function mintCode() {
    const data = await call({
      method: "PATCH",
      body: JSON.stringify({ businessId, mintLinkCodeFor: { isOwner: true, employeeId: null } })
    });
    if (data?.linkCode) setLinkCode(data.linkCode);
  }

  async function disconnect() {
    const data = await call({ method: "DELETE" }, `?businessId=${encodeURIComponent(businessId)}`);
    if (!data) return;
    setConnection(null);
    setLinkCode(null);
    setNotice("Disconnected.");
  }

  if (!tierAllowed) {
    return (
      <Card>
        <h2 className="text-lg text-parchment">Telegram</h2>
        <p className="mt-2 text-sm text-parchment/60">
          The Telegram integration is available on Standard and Enterprise plans.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="text-lg text-parchment">Telegram</h2>
        {connection ? (
          <Badge variant={connection.is_active ? "success" : "pending"}>
            {connection.is_active ? "Connected" : "Paused"}
          </Badge>
        ) : (
          <Badge variant="neutral">Not connected</Badge>
        )}
      </div>

      {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
      {notice ? <p className="mt-3 text-sm text-claw-green">{notice}</p> : null}

      {!connection ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-parchment/60">
            Your coworker gets its own Telegram bot, under your business&apos;s name. Urgent alerts
            arrive there, and you can message it back to ask anything.
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-parchment/60">
            <li>
              In Telegram, message <span className="text-parchment">@BotFather</span> and send{" "}
              <span className="text-parchment">/newbot</span>.
            </li>
            <li>Give it a name and a username.</li>
            <li>Paste the token BotFather sends you below.</li>
          </ol>
          <input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="123456789:AA..."
            aria-label="Telegram bot token"
            className="w-full rounded border border-parchment/20 bg-transparent px-3 py-2 text-sm text-parchment"
          />
          <Button onClick={connect} disabled={busy || botToken.trim().length < 20}>
            {busy ? "Checking with Telegram…" : "Connect"}
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-parchment/60">
            Connected as{" "}
            <span className="text-parchment">
              {connection.external_workspace_name ?? `bot ${connection.external_workspace_id}`}
            </span>
            .
          </p>

          <div className="space-y-2">
            <p className="text-sm text-parchment">Where alerts go</p>
            {connection.alert_target_id ? (
              <p className="text-sm text-parchment/60">
                Chat <span className="text-parchment">{connection.alert_target_id}</span>. Send a
                different chat id below to move them.
              </p>
            ) : (
              <p className="text-sm text-parchment/60">
                Message your bot from the chat you want alerts in, then paste that chat id here. We
                post a test message before saving it, so a wrong id fails now rather than silently
                later.
              </p>
            )}
            <div className="flex gap-2">
              <input
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="-1001234567890"
                aria-label="Telegram alert chat id"
                className="flex-1 rounded border border-parchment/20 bg-transparent px-3 py-2 text-sm text-parchment"
              />
              <Button onClick={saveAlertChat} disabled={busy || chatId.trim().length === 0}>
                Save
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm text-parchment">Connect your Telegram account</p>
            <p className="text-sm text-parchment/60">
              Your coworker only answers accounts you have connected. The easiest way is to message
              the bot and tap &quot;Share my phone number&quot;. If you would rather not, generate a
              one-time code and send it to the bot instead.
            </p>
            {linkCode ? (
              <p className="text-sm text-parchment">
                Send <span className="font-mono text-claw-green">{linkCode.code}</span> to your bot.
                It works once, and expires in 15 minutes.
              </p>
            ) : null}
            <Button variant="secondary" onClick={mintCode} disabled={busy}>
              Generate a connect code
            </Button>
          </div>

          <div className="flex gap-2 pt-2">
            <Button variant="secondary" onClick={() => setActive(!connection.is_active)} disabled={busy}>
              {connection.is_active ? "Pause" : "Resume"}
            </Button>
            <Button variant="secondary" onClick={disconnect} disabled={busy}>
              Disconnect
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
