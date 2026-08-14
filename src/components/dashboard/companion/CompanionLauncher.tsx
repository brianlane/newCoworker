"use client";

/**
 * The floating "Ask AI" launcher, mounted once in the dashboard layout so
 * the companion is reachable from every page. Hidden on /dashboard/chat
 * itself (the full chat IS the companion there). The panel mounts lazily
 * on first open and stays mounted afterwards so the conversation state
 * survives open/close within a page visit; the transport hook it uses is
 * the page's own (same endpoints, same active thread).
 */

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import { CompanionPanel } from "@/components/dashboard/companion/CompanionPanel";

type Props = {
  businessId: string;
  viewAsActive: boolean;
};

export function CompanionLauncher({ businessId, viewAsActive }: Props) {
  const t = useTranslations("dashboard.companion");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Latch: once opened, keep the panel mounted (hidden) so switching pages'
  // worth of state (messages, tab) is not torn down on every close.
  const [everOpened, setEverOpened] = useState(false);

  if (pathname === "/dashboard/chat" || pathname?.startsWith("/dashboard/chat/")) {
    return null;
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setEverOpened(true);
          }}
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-claw-green px-4 py-2.5 text-sm font-semibold text-deep-ink shadow-lg transition-transform hover:scale-105"
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          {t("launcher.open")}
        </button>
      )}
      {everOpened && (
        <div className={open ? "" : "hidden"}>
          <CompanionPanel
            businessId={businessId}
            viewAsActive={viewAsActive}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}
