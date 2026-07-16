"use client";

import { useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Download, FileText, Upload } from "lucide-react";

type Props = { businessId: string };

type CsvType = "contacts" | "employees" | "documents";

type ImportSummary = {
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; message: string }[];
};

type ApiError = { error?: { message?: string } };

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as ApiError | null;
  return json?.error?.message || `HTTP ${res.status}`;
}

const DATASETS: { type: CsvType; title: string; blurb: string }[] = [
  {
    type: "contacts",
    title: "Contacts",
    blurb: "Everyone in the directory: customers, companies, testers. Import updates by phone number."
  },
  {
    type: "employees",
    title: "Employees",
    blurb: "The team roster AiFlows route leads through, including schedules. Import updates by phone number."
  },
  {
    type: "documents",
    title: "Contact records",
    blurb:
      "Policies, leases, contracts, memberships — records linked to a contact with renewal dates. Import your book of business; the contact must exist first."
  }
];

/**
 * CSV import/export cards (modeled on BizBlasts' /manage/csv page): per
 * dataset — export the current data, download a template, or upload a CSV.
 * Imports run synchronously and report created/updated/skipped plus per-row
 * errors inline.
 */
export function CsvImportExport({ businessId }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ type: CsvType; summary: ImportSummary } | null>(null);
  const fileInputs = useRef<Partial<Record<CsvType, HTMLInputElement | null>>>({});

  function downloadUrl(type: CsvType, mode: "export" | "template"): string {
    return `/api/dashboard/csv?businessId=${encodeURIComponent(businessId)}&type=${type}&mode=${mode}`;
  }

  async function download(type: CsvType, mode: "export" | "template") {
    const key = `${type}:${mode}`;
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(downloadUrl(type, mode));
      if (!res.ok) throw new Error(await readError(res));
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download =
        res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ??
        `${type}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function importFile(type: CsvType, file: File) {
    setBusy(`${type}:import`);
    setError(null);
    setResult(null);
    try {
      const text = await file.text();
      const res = await fetch(
        `/api/dashboard/csv?businessId=${encodeURIComponent(businessId)}&type=${type}`,
        { method: "POST", headers: { "Content-Type": "text/csv" }, body: text }
      );
      if (!res.ok) throw new Error(await readError(res));
      const json = (await res.json()) as { data?: { summary?: ImportSummary } };
      if (json.data?.summary) setResult({ type, summary: json.data.summary });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      const input = fileInputs.current[type];
      if (input) input.value = "";
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="text-xs text-red-300 border border-red-400/30 bg-red-400/5 rounded-lg px-3 py-2">
          {error}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {DATASETS.map(({ type, title, blurb }) => (
          <Card key={type}>
            <h3 className="text-sm font-semibold text-parchment">{title}</h3>
            <p className="text-xs text-parchment/50 mt-1 mb-4">{blurb}</p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => download(type, "export")}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-lg bg-claw-green text-deep-ink px-3 py-2 text-xs font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" />
                {busy === `${type}:export` ? "Exporting…" : "Export CSV"}
              </button>
              <button
                type="button"
                onClick={() => fileInputs.current[type]?.click()}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-lg bg-signal-teal text-deep-ink px-3 py-2 text-xs font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40"
              >
                <Upload className="h-3.5 w-3.5" />
                {busy === `${type}:import` ? "Importing…" : "Import CSV"}
              </button>
              <button
                type="button"
                onClick={() => download(type, "template")}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-parchment/20 text-parchment/70 px-3 py-2 text-xs hover:bg-parchment/5 transition-colors disabled:opacity-40"
                title="Download a template showing the expected columns"
              >
                <FileText className="h-3.5 w-3.5" />
                {busy === `${type}:template` ? "…" : "Template"}
              </button>
              <input
                ref={(el) => {
                  fileInputs.current[type] = el;
                }}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                aria-label={`Import ${title} CSV`}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importFile(type, file);
                }}
              />
            </div>
            {result?.type === type && (
              <div className="mt-4 rounded-lg border border-parchment/10 bg-deep-ink/40 px-3 py-2">
                <p className="text-xs text-parchment/80">
                  {result.summary.totalRows} row{result.summary.totalRows === 1 ? "" : "s"}:{" "}
                  <span className="text-claw-green">{result.summary.created} created</span>,{" "}
                  <span className="text-signal-teal">{result.summary.updated} updated</span>,{" "}
                  {result.summary.skipped} skipped
                </p>
                {result.summary.errors.length > 0 && (
                  <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                    {result.summary.errors.map((err, i) => (
                      <li key={i} className="text-[11px] text-red-300">
                        {err.row > 0 ? `Row ${err.row}: ` : ""}
                        {err.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>
      <p className="text-xs text-parchment/40">
        Imports match rows by phone number: existing entries are updated (blank cells leave the
        current value untouched) and new numbers are created. Download a template to see the
        expected columns; files are capped at 2,000 rows.
      </p>
    </div>
  );
}
