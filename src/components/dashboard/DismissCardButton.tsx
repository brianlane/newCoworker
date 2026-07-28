"use client";

/**
 * The X in the corner of a dismissible starter card. Hiding a card is purely
 * cosmetic (see src/lib/dashboard/dismissed-cards.ts): an installed flow keeps
 * running and every starter stays available from the AiFlow library, so this
 * never costs the tenant an automation.
 *
 * Absolutely positioned, so the host card must be `relative`.
 */

import { X } from "lucide-react";
import { useTranslations } from "next-intl";

export function DismissCardButton({ onDismiss }: { onDismiss: () => void }) {
  const t = useTranslations("dashboard.pages");
  const label = t("starterDismiss");
  return (
    <button
      type="button"
      onClick={onDismiss}
      title={label}
      aria-label={label}
      className="absolute right-2 top-2 rounded-md p-1 text-parchment/30 hover:bg-parchment/5 hover:text-parchment/70"
    >
      <X className="h-4 w-4" />
    </button>
  );
}
