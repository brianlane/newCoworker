"use client";

/**
 * "Import from Follow Up Boss" card on /dashboard/import-export.
 *
 * Flow: pick the CSV you exported from Follow Up Boss (People, then Export
 * with "Export All Columns" checked), PREVIEW it, then import. The preview
 * writes nothing and names every column it could not place, so a column the
 * owner cares about is never dropped without them seeing it.
 *
 * The file never leaves the browser until a button is pressed, and the
 * server never stores it: the preview and the import each send it once.
 * There is no API key on this surface, deliberately. See
 * src/lib/fub-import/run.ts for why.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { CloudDownload, FileSpreadsheet } from "lucide-react";

type Props = { businessId: string };

type Preview = {
  totalRows: number;
  importable: number;
  unusable: number;
  mapping: Record<string, string[]>;
  ignoredColumns: string[];
  problems: string[];
};

type Summary = {
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  failures: string[];
};

type PublicJob = {
  id: string;
  status: "pending" | "dry_run_done" | "running" | "done" | "failed";
  dryRun: boolean;
  counts: { preview?: Preview; summary?: Summary };
  error: string | null;
};

type ApiError = { error?: { message?: string } };

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as ApiError | null;
  return json?.error?.message || `HTTP ${res.status}`;
}

/** Field keys the server reports, in the order the card lists them. */
const FIELD_ORDER = [
  "name",
  "firstName",
  "lastName",
  "phone",
  "email",
  "stage",
  "source",
  "tags"
] as const;

export function FubImport({ businessId }: Props) {
  const t = useTranslations("dashboard.fubImport");
  const [job, setJob] = useState<PublicJob | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The preview the buttons act on, held here rather than read back off the
  // job row: it belongs to the file currently picked, and picking a new file
  // must invalidate it even though the old job row still exists.
  const [preview, setPreview] = useState<Preview | null>(null);
  const stopped = useRef(false);

  const refresh = useCallback(async () => {
    const res = await fetch(
      `/api/dashboard/import/fub?businessId=${encodeURIComponent(businessId)}`
    );
    if (!res.ok) return;
    const json = (await res.json()) as { data?: { job?: PublicJob | null } };
    if (!stopped.current && json.data) setJob(json.data.job ?? null);
  }, [businessId]);

  useEffect(() => {
    stopped.current = false;
    void refresh();
    return () => {
      stopped.current = true;
    };
  }, [refresh]);

  async function send(dryRun: boolean) {
    if (!file) {
      setError(t("fileMissing"));
      return;
    }
    setBusy(dryRun ? "preview" : "import");
    setError(null);
    try {
      const csv = await file.text();
      const res = await fetch(
        `/api/dashboard/import/fub?businessId=${encodeURIComponent(businessId)}&dryRun=${dryRun}`,
        { method: "POST", headers: { "Content-Type": "text/csv" }, body: csv }
      );
      if (!res.ok) throw new Error(await readError(res));
      const json = (await res.json()) as { data?: { job?: PublicJob } };
      if (json.data?.job && !stopped.current) {
        setJob(json.data.job);
        setPreview(json.data.job.counts.preview ?? null);
      }
    } catch (e) {
      if (!stopped.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!stopped.current) setBusy(null);
    }
  }

  const summary = job?.counts.summary;
  const imported = job?.status === "done" && !job.dryRun;

  return (
    <Card>
      <h3 className="text-sm font-semibold text-parchment flex items-center gap-2">
        <CloudDownload className="h-4 w-4" />
        {t("title")}
      </h3>
      <p className="text-xs text-parchment/50 mt-1">{t("blurb")}</p>
      <p className="text-[11px] text-parchment/40 mt-1 mb-4">{t("howToExport")}</p>

      {error && (
        <p className="text-xs text-red-300 border border-red-400/30 bg-red-400/5 rounded-lg px-3 py-2 mb-3">
          {error}
        </p>
      )}
      {job?.status === "failed" && job.error && (
        <p className="text-xs text-red-300 border border-red-400/30 bg-red-400/5 rounded-lg px-3 py-2 mb-3">
          {job.error}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex-1 min-w-[220px]">
          <span className="block text-xs text-parchment/70 mb-1">{t("fileLabel")}</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              // A new file makes the old preview meaningless.
              setPreview(null);
              setError(null);
            }}
            className="w-full rounded-lg bg-deep-ink/60 border border-parchment/20 px-3 py-2 text-xs text-parchment file:mr-3 file:rounded file:border-0 file:bg-parchment/10 file:px-2 file:py-1 file:text-xs file:text-parchment"
          />
        </label>
        <button
          type="button"
          onClick={() => void send(true)}
          disabled={busy !== null || !file}
          className="inline-flex items-center gap-1.5 rounded-lg bg-signal-teal text-deep-ink px-3 py-2 text-xs font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40"
        >
          <FileSpreadsheet className="h-3.5 w-3.5" />
          {busy === "preview" ? t("previewRunning") : t("previewButton")}
        </button>
      </div>

      {preview && (
        <div className="mt-4 rounded-lg border border-parchment/10 bg-deep-ink/40 px-3 py-3 space-y-2">
          <p className="text-xs font-semibold text-parchment">{t("previewTitle")}</p>
          <p className="text-xs text-parchment/80">
            {t("previewRows", {
              total: preview.totalRows,
              importable: preview.importable,
              unusable: preview.unusable
            })}
          </p>
          <div>
            <p className="text-[11px] text-parchment/60">{t("previewMapping")}</p>
            <ul className="mt-1 space-y-0.5">
              {FIELD_ORDER.filter((f) => preview.mapping[f]?.length).map((f) => (
                <li key={f} className="text-[11px] text-parchment/70">
                  {t(`field.${f}`)}: {preview.mapping[f].join(", ")}
                </li>
              ))}
            </ul>
          </div>
          {preview.ignoredColumns.length > 0 && (
            <p className="text-[11px] text-parchment/60">
              {t("previewIgnored")}: {preview.ignoredColumns.join(", ")}
            </p>
          )}
          {preview.problems.length > 0 && (
            <div>
              <p className="text-[11px] text-amber-300">{t("previewProblems")}</p>
              <ul className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                {preview.problems.map((p, i) => (
                  <li key={i} className="text-[11px] text-amber-300/80">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[11px] text-parchment/40">{t("notesDealsNote")}</p>
        </div>
      )}

      {preview && preview.importable > 0 && (
        <div className="mt-4 space-y-2">
          <button
            type="button"
            onClick={() => void send(false)}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-claw-green text-deep-ink px-3 py-2 text-xs font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40"
          >
            <CloudDownload className="h-3.5 w-3.5" />
            {busy === "import"
              ? t("importRunning")
              : t("importButton", { count: preview.importable })}
          </button>
          <p className="text-[11px] text-parchment/40">{t("automationsNote")}</p>
        </div>
      )}

      {summary && imported && (
        <div className="mt-4 rounded-lg border border-parchment/10 bg-deep-ink/40 px-3 py-3 space-y-1">
          <p className="text-xs font-semibold text-parchment">{t("resultTitleDone")}</p>
          <p className="text-xs text-parchment/80">
            {t("resultContacts", {
              created: summary.created,
              updated: summary.updated,
              skipped: summary.skipped
            })}
          </p>
          {summary.failures.length > 0 && (
            <div className="pt-1">
              <p className="text-[11px] text-red-300">
                {t("failuresTitle", { count: summary.skipped })}
              </p>
              <ul className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                {summary.failures.map((f, i) => (
                  <li key={i} className="text-[11px] text-red-300/80">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
