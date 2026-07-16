"use client";

/**
 * WhatsApp Business connection card for /dashboard/integrations.
 *
 * "Connect WhatsApp" launches Meta's EMBEDDED SIGNUP popup (FB JS SDK
 * `FB.login` with our app's signup configuration): the owner creates or
 * links their WhatsApp Business Account + phone number inside the popup,
 * which hands back a one-time code plus the WABA/phone ids via a window
 * message. We POST those to /api/integrations/whatsapp, which exchanges
 * the code server-side, subscribes the WABA to our webhooks, and
 * auto-registers the stock utility templates (owner alerts +
 * out-of-window follow-ups, reviewed by Meta — usually minutes).
 *
 * API contract (/api/integrations/whatsapp):
 *   GET    ?businessId=…
 *   POST   {businessId, code, wabaId, phoneNumberId, displayPhoneNumber?}
 *   PATCH  {businessId, isActive}
 *   DELETE {businessId}
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type TemplatesState = Record<string, { status: string; language: string }>;

type WhatsAppConnection = {
  id: string;
  business_id: string;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string | null;
  templates: TemplatesState | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type Props = {
  businessId: string;
  initialConnection: WhatsAppConnection | null;
  /** The platform Meta app id (public by design — it ships in the SDK init). */
  metaAppId: string | null;
  /** Embedded Signup configuration id from the Meta app dashboard. */
  configId: string | null;
};

type SessionInfo = { wabaId: string; phoneNumberId: string };

declare global {
  interface Window {
    FB?: {
      init: (opts: { appId: string; version: string }) => void;
      login: (
        cb: (response: { authResponse?: { code?: string } | null }) => void,
        opts: Record<string, unknown>
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

export function WhatsAppIntegrationCard({
  businessId,
  initialConnection,
  metaAppId,
  configId
}: Props) {
  const [connection, setConnection] = useState<WhatsAppConnection | null>(initialConnection);
  const [banner, setBanner] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [sdkReady, setSdkReady] = useState(false);
  // The popup reports WABA/phone ids and the login code on separate
  // channels; whichever arrives second completes the connect.
  const sessionInfoRef = useRef<SessionInfo | null>(null);
  const codeRef = useRef<string | null>(null);

  const configured = Boolean(metaAppId && configId);

  // FB JS SDK, loaded once on demand.
  useEffect(() => {
    if (!configured || connection) return;
    if (window.FB) {
      setSdkReady(true);
      return;
    }
    window.fbAsyncInit = () => {
      window.FB?.init({ appId: metaAppId as string, version: "v25.0" });
      setSdkReady(true);
    };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    document.body.appendChild(script);
  }, [configured, connection, metaAppId]);

  const finishConnect = useCallback(async () => {
    const code = codeRef.current;
    const info = sessionInfoRef.current;
    if (!code || !info) return; // the other half hasn't arrived yet
    codeRef.current = null;
    sessionInfoRef.current = null;
    try {
      const res = await fetch("/api/integrations/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          code,
          wabaId: info.wabaId,
          phoneNumberId: info.phoneNumberId
        })
      });
      const json = (await res.json()) as {
        data?: { connection?: WhatsAppConnection };
        error?: { message?: string };
      };
      if (!res.ok) {
        setBanner(json.error?.message ?? "Could not finish the WhatsApp setup");
        return;
      }
      setConnection(json.data?.connection ?? null);
      setBanner(null);
    } finally {
      setConnecting(false);
    }
  }, [businessId]);

  // Embedded Signup posts the created WABA + phone number ids back via a
  // window message from facebook.com.
  useEffect(() => {
    if (!configured || connection) return;
    const onMessage = (event: MessageEvent) => {
      // Exact host allowlist — a suffix string check would also match
      // "evilfacebook.com". The dot boundary keeps subdomains valid.
      let host: string;
      try {
        host = new URL(event.origin).hostname;
      } catch {
        return;
      }
      if (host !== "facebook.com" && !host.endsWith(".facebook.com")) return;
      try {
        const data = JSON.parse(event.data as string) as {
          type?: string;
          event?: string;
          data?: { waba_id?: string; phone_number_id?: string };
        };
        if (data.type !== "WA_EMBEDDED_SIGNUP") return;
        if (data.event === "FINISH" && data.data?.waba_id && data.data.phone_number_id) {
          sessionInfoRef.current = {
            wabaId: data.data.waba_id,
            phoneNumberId: data.data.phone_number_id
          };
          void finishConnect();
        } else if (data.event === "CANCEL") {
          setConnecting(false);
        }
      } catch {
        // Non-JSON messages from other facebook.com frames — ignore.
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [configured, connection, finishConnect]);

  function launchSignup() {
    if (!window.FB) return;
    setBanner(null);
    setConnecting(true);
    window.FB.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          setConnecting(false);
          setBanner("WhatsApp setup was cancelled");
          return;
        }
        codeRef.current = code;
        void finishConnect();
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, sessionInfoVersion: "3" }
      }
    );
  }

  async function toggleActive() {
    if (!connection) return;
    setToggling(true);
    setBanner(null);
    try {
      const res = await fetch("/api/integrations/whatsapp", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, isActive: !connection.is_active })
      });
      const json = (await res.json()) as {
        data?: { connection?: WhatsAppConnection };
        error?: { message?: string };
      };
      if (!res.ok) {
        setBanner(json.error?.message ?? "Could not update the connection");
        return;
      }
      setConnection(json.data?.connection ?? connection);
    } finally {
      setToggling(false);
    }
  }

  async function disconnect() {
    setBanner(null);
    setRemoving(true);
    try {
      const res = await fetch(
        `/api/integrations/whatsapp?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setBanner(json?.error?.message ?? "Could not disconnect WhatsApp");
        return;
      }
      setConnection(null);
    } finally {
      setRemoving(false);
    }
  }

  const templates = Object.entries(connection?.templates ?? {});
  const templatesPending = templates.some(([, t]) => t.status !== "APPROVED");

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-parchment">WhatsApp Business</h3>
          <p className="text-sm text-parchment/50 mt-0.5">
            Chat with leads on WhatsApp — your coworker answers automatically, and
            AiFlows and owner alerts can message contacts there too.
          </p>
        </div>
        {connection ? (
          <Badge variant={connection.is_active ? "success" : "neutral"}>
            {connection.is_active ? "Connected" : "Paused"}
          </Badge>
        ) : null}
      </div>

      {banner ? <p className="text-xs text-spark-orange mt-3">{banner}</p> : null}

      {!connection ? (
        <div className="mt-4 space-y-3">
          {!configured ? (
            <p className="text-xs text-parchment/40">
              WhatsApp isn&apos;t available yet — the platform&apos;s Meta app is still
              being configured.
            </p>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={launchSignup}
                loading={connecting}
                disabled={!sdkReady}
              >
                Connect WhatsApp
              </Button>
              <p className="text-[11px] text-parchment/40">
                Opens Meta&apos;s guided setup: link (or create) your WhatsApp Business
                Account and pick a phone number. The number can&apos;t already be in use
                on the consumer WhatsApp app. Replies inside a conversation are free;
                messages your coworker starts outside a 24-hour window use Meta-approved
                templates and are billed by Meta to your account.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-parchment/70">
            {connection.display_phone_number
              ? `Number ${connection.display_phone_number}`
              : `Number id ${connection.phone_number_id}`}
            {" · conversations appear under "}
            <a href="/dashboard/whatsapp" className="text-signal-teal hover:underline">
              WhatsApp
            </a>
          </p>
          {templates.length > 0 ? (
            <p className="text-[11px] text-parchment/40">
              Message templates:{" "}
              {templates
                .map(([name, t]) => `${name.replace(/^nc_/, "")} (${t.status.toLowerCase()})`)
                .join(" · ")}
              {templatesPending
                ? " — templates awaiting Meta review only send inside an open 24-hour conversation window."
                : ""}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={toggleActive} loading={toggling}>
              {connection.is_active ? "Pause" : "Resume"}
            </Button>
            <Button variant="ghost" size="sm" onClick={disconnect} loading={removing}>
              Disconnect
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
