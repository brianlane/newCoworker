"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import type { SmsLinkView } from "@/lib/db/sms-links";

type Props = {
  links: SmsLinkView[];
  mode?: "compact" | "full";
  businessId: string;
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="text-[10px] text-signal-teal hover:underline"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ClickTimeline({ link }: { link: SmsLinkView }) {
  const t = useTranslations("dashboard.trackedLinks");
  const [open, setOpen] = useState(false);
  if (link.click_count === 0) {
    return <span className="text-parchment/40">No clicks yet</span>;
  }
  const events = link.clicks.length > 0 ? link.clicks : [];
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-signal-teal hover:underline text-left"
      >
        Clicked {link.click_count} time{link.click_count === 1 ? "" : "s"}
        {events.length > 0 ? (open ? " ▾" : " ▸") : null}
      </button>
      {open && events.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-2 border-l border-parchment/10">
          {events.map((c) => (
            <li key={c.id} className="text-[11px] text-parchment/60">
              <LocalDateTime iso={c.clicked_at} />
              {c.likely_prefetch && (
                <span
                  className="ml-1.5 text-[10px] uppercase tracking-wide text-parchment/35"
                  title={t("previewFetch")}
                >
                  {t("previewFetch")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {link.first_clicked_at && (
        <p className="text-[10px] text-parchment/40 mt-0.5">
          First <LocalDateTime iso={link.first_clicked_at} />
          {link.last_clicked_at && link.click_count > 1 ? (
            <>
              {" · "}
              Last <LocalDateTime iso={link.last_clicked_at} />
            </>
          ) : null}
        </p>
      )}
    </div>
  );
}

export function TrackedLinksPanel({ links, mode = "full" }: Props) {
  if (links.length === 0) {
    return <p className="text-xs text-parchment/50">No tracked links yet.</p>;
  }

  if (mode === "compact") {
    return (
      <div className="mt-2 space-y-1.5 border-t border-parchment/10 pt-2">
        {links.map((link) => (
          <div key={link.id} className="text-[11px] text-parchment/70">
            <span className="font-mono text-parchment/50">{link.short_code}</span>
            {" · "}
            <ClickTimeline link={link} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {links.map((link) => (
        <div
          key={link.id}
          className="rounded-lg border border-parchment/10 bg-parchment/[0.02] p-3 space-y-1.5"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            {link.to_e164 ? (
              <Link
                href={`/dashboard/customers/${encodeURIComponent(link.to_e164)}`}
                className="font-semibold text-parchment hover:text-claw-green"
              >
                {link.contactName ?? link.to_e164}
              </Link>
            ) : (
              <span className="font-semibold text-parchment/70">Group send</span>
            )}
            <span className="font-mono text-xs text-parchment/50">
              {link.shortUrl.replace(/^https?:\/\//, "")}
            </span>
            <CopyButton text={link.shortUrl} />
          </div>
          <p className="text-xs text-parchment/60 break-all">
            →{" "}
            <a
              href={link.original_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-signal-teal hover:underline"
            >
              {link.original_url}
            </a>
          </p>
          <div className="text-xs text-parchment/70">
            <ClickTimeline link={link} />
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-parchment/40">
            {link.flowName && link.flow_id && (
              <Link
                href={`/dashboard/aiflows/${link.flow_id}`}
                className="hover:text-parchment"
              >
                Flow: {link.flowName}
              </Link>
            )}
            {link.run_id && (
              <Link
                href={`/dashboard/aiflows/runs#run-${link.run_id}`}
                className="hover:text-parchment"
              >
                Run
              </Link>
            )}
            {link.sms_outbound_log_id && link.to_e164 && (
              <Link
                href={`/dashboard/messages/${encodeURIComponent(link.to_e164)}`}
                className="hover:text-parchment"
              >
                Message thread
              </Link>
            )}
            <span>
              Sent <LocalDateTime iso={link.created_at} />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
