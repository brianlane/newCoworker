"use client";

/**
 * "Recent changes" for one table, with an Undo button per entry.
 *
 * The entries arrive already worded: the pairing that turns a "state before"
 * snapshot into "what the change DID" lives in
 * src/lib/custom-tables/version-history.ts with tests, because the off-by-one
 * in that pairing is exactly what a component would never check. This
 * renders them verbatim.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { RotateCcw } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import type { CustomTableHistoryEntry } from "@/lib/custom-tables/version-history";

type Props = {
  entries: CustomTableHistoryEntry[] | null;
  canManage: boolean;
  onRestore: (versionId: number) => Promise<void>;
};

export function CustomTableHistory({ entries, canManage, onRestore }: Props) {
  const t = useTranslations("dashboard.tables");
  const [restoringId, setRestoringId] = useState<number | null>(null);

  if (entries === null) {
    return (
      <Card>
        <p className="text-sm text-parchment/50">{t("loading")}</p>
      </Card>
    );
  }

  if (entries.length === 0) {
    return (
      <Card>
        <p className="py-4 text-center text-sm text-parchment/50">{t("historyEmpty")}</p>
      </Card>
    );
  }

  return (
    <Card padding="sm">
      <ul className="divide-y divide-parchment/10">
        {entries.map((entry) => (
          <li key={entry.versionId} className="flex items-start justify-between gap-3 py-2.5">
            <div className="min-w-0 space-y-0.5">
              <p className="text-xs text-parchment/40">
                <LocalDateTime iso={entry.replacedAt} /> · {entry.by}
                {entry.actor && <span className="text-parchment/30"> ({entry.actor})</span>}
              </p>
              {entry.changeSummary.length === 0 ? (
                <p className="text-sm text-parchment/50">{t("historyNoDetail")}</p>
              ) : (
                <ul className="space-y-0.5">
                  {entry.changeSummary.map((line, i) => (
                    <li key={i} className="text-sm text-parchment/75">
                      {line}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {canManage &&
              (entry.restorable ? (
                <button
                  type="button"
                  onClick={async () => {
                    setRestoringId(entry.versionId);
                    try {
                      await onRestore(entry.versionId);
                    } finally {
                      setRestoringId(null);
                    }
                  }}
                  disabled={restoringId !== null}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-parchment/15 px-2.5 py-1 text-xs text-parchment/70 hover:text-parchment disabled:opacity-40"
                >
                  <RotateCcw className="h-3 w-3" />
                  {restoringId === entry.versionId ? t("historyRestoring") : t("historyRestore")}
                </button>
              ) : (
                <span className="shrink-0 text-[11px] text-parchment/30">
                  {t("historyUnrestorable")}
                </span>
              ))}
          </li>
        ))}
      </ul>
    </Card>
  );
}
