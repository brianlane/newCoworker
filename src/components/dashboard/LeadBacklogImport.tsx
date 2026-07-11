"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { AlertTriangle, Upload } from "lucide-react";

type Props = { businessId: string };

type Preview = {
  headers: string[];
  totalRows: number;
  sampleRows: Record<string, string>[];
  webhookFlowsEnabled: number;
  /** Enabled, batch-runnable flows offered as explicit import targets. */
  flows: { id: string; name: string }[];
};

type ImportSummary = {
  totalRows: number;
  enqueued: number;
  duplicates: number;
  unmatched: number;
  skipped: number;
  errors: { row: number; message: string }[];
  flowsEvaluated: number;
};

type ApiError = { error?: { message?: string } };

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as ApiError | null;
  return json?.error?.message || `HTTP ${res.status}`;
}

/**
 * Turn the picked file into CSV text: .csv reads as-is; .xlsx/.xls converts
 * the FIRST worksheet via SheetJS, loaded lazily so the (large) parser is
 * fetched only when an owner actually picks an Excel file.
 */
async function fileToCsvText(file: File): Promise<string> {
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const first = workbook.SheetNames[0];
    if (!first) throw new Error("The Excel file has no worksheets.");
    return XLSX.utils.sheet_to_csv(workbook.Sheets[first]);
  }
  return file.text();
}

const DRIP_CHOICES = [
  { label: "1 lead per minute", seconds: 60 },
  { label: "1 lead every 5 minutes", seconds: 300 },
  { label: "1 lead every 15 minutes", seconds: 900 },
  { label: "All at once", seconds: 0 }
] as const;

/**
 * "Import a lead backlog" card: upload an Excel/CSV sheet of leads and run
 * an AiFlow on each row, drip-released so the backlog doesn't blast SMS/
 * email budgets in one sweep. Two-step: preview (parsed headers + row count
 * + the target-flow picker), then import. The owner either picks ONE flow to
 * run per row (no trigger changes needed) or lets rows trigger-match every
 * webhook-triggered flow, the way a live Zapier/Make lead does.
 */
export function LeadBacklogImport({ businessId }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [source, setSource] = useState("backlog_import");
  const [dripSeconds, setDripSeconds] = useState<number>(60);
  /** "" = trigger-match webhook flows; otherwise the target flow's id. */
  const [flowId, setFlowId] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const endpoint = (mode?: "preview") =>
    `/api/dashboard/aiflows/lead-import?businessId=${encodeURIComponent(businessId)}${
      mode ? `&mode=${mode}` : ""
    }`;

  async function pickFile(file: File) {
    setBusy(true);
    setError(null);
    setPreview(null);
    setSummary(null);
    setCsvText(null);
    try {
      const csv = await fileToCsvText(file);
      const res = await fetch(endpoint("preview"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv })
      });
      if (!res.ok) throw new Error(await readError(res));
      const json = (await res.json()) as { data?: Preview };
      if (!json.data) throw new Error("Unexpected response");
      setCsvText(csv);
      setFileName(file.name);
      setPreview(json.data);
      // Keep a previously chosen target only if it is still offered.
      const flows = json.data.flows;
      setFlowId((cur) => (flows.some((f) => f.id === cur) ? cur : ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function runImport() {
    if (!csvText) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csv: csvText,
          source: source.trim() || undefined,
          dripIntervalSeconds: dripSeconds,
          ...(flowId ? { flowId } : {})
        })
      });
      if (!res.ok) throw new Error(await readError(res));
      const json = (await res.json()) as { data?: { summary?: ImportSummary } };
      if (!json.data?.summary) throw new Error("Unexpected response");
      setSummary(json.data.summary);
      setPreview(null);
      setCsvText(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h3 className="text-sm font-semibold text-parchment">Import a lead backlog</h3>
      <p className="text-xs text-parchment/50 mt-1 mb-4">
        Upload an Excel or CSV sheet of leads and pick which AiFlow runs for each row,
        released gradually so a big backlog doesn&apos;t send everything at once.
        Re-uploading the same sheet never runs a lead twice.
      </p>

      {error && (
        <p className="mb-3 text-xs text-red-300 border border-red-400/30 bg-red-400/5 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-signal-teal text-deep-ink px-3 py-2 text-xs font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40"
        >
          <Upload className="h-3.5 w-3.5" />
          {busy ? "Working…" : "Choose Excel / CSV file"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          aria-label="Import lead backlog spreadsheet"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void pickFile(file);
          }}
        />
      </div>

      {preview && (
        <div className="mt-4 space-y-3 rounded-lg border border-parchment/10 bg-deep-ink/40 px-3 py-3">
          <p className="text-xs text-parchment/80">
            <span className="font-semibold">{fileName}</span>: {preview.totalRows} lead
            {preview.totalRows === 1 ? "" : "s"}, columns{" "}
            <span className="text-parchment/60">{preview.headers.join(", ")}</span>
          </p>

          {preview.sampleRows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-[11px] text-parchment/70">
                <thead>
                  <tr>
                    {preview.headers.map((h) => (
                      <th key={h} className="pr-4 pb-1 text-left font-semibold text-parchment/50">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sampleRows.map((row, i) => (
                    <tr key={i}>
                      {preview.headers.map((h) => (
                        <td key={h} className="pr-4 py-0.5 whitespace-nowrap max-w-48 truncate">
                          {row[h] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {flowId === "" && preview.webhookFlowsEnabled === 0 && (
            <p className="flex items-start gap-1.5 text-xs text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                {preview.flows.length > 0
                  ? "No enabled AiFlow starts from a webhook event — pick the flow to run for each lead below."
                  : "No enabled AiFlow can run these leads. Create (or enable) a flow first, then come back."}
              </span>
            </p>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-parchment/60">
              Run for each lead
              <select
                value={flowId}
                onChange={(e) => setFlowId(e.target.value)}
                className="mt-1 block w-64 rounded-lg border border-parchment/20 bg-deep-ink px-2 py-1.5 text-xs text-parchment"
              >
                <option value="">
                  Flows with a &quot;Webhook event&quot; trigger ({preview.webhookFlowsEnabled}{" "}
                  enabled)
                </option>
                {preview.flows.map((f) => (
                  <option key={f.id} value={f.id}>
                    Only: {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-parchment/60">
              Source label
              <input
                type="text"
                value={source}
                maxLength={120}
                onChange={(e) => setSource(e.target.value)}
                className="mt-1 block w-44 rounded-lg border border-parchment/20 bg-deep-ink px-2 py-1.5 text-xs text-parchment"
              />
            </label>
            <label className="text-xs text-parchment/60">
              Release speed
              <select
                value={dripSeconds}
                onChange={(e) => setDripSeconds(Number(e.target.value))}
                className="mt-1 block w-44 rounded-lg border border-parchment/20 bg-deep-ink px-2 py-1.5 text-xs text-parchment"
              >
                {DRIP_CHOICES.map((c) => (
                  <option key={c.seconds} value={c.seconds}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void runImport()}
              disabled={busy || (flowId === "" && preview.webhookFlowsEnabled === 0)}
              title={
                flowId === "" && preview.webhookFlowsEnabled === 0
                  ? "Pick a flow to run for each lead first"
                  : undefined
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-claw-green text-deep-ink px-3 py-2 text-xs font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40"
            >
              {busy ? "Importing…" : `Import ${preview.totalRows} lead${preview.totalRows === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}

      {summary && (
        <div className="mt-4 rounded-lg border border-parchment/10 bg-deep-ink/40 px-3 py-2">
          <p className="text-xs text-parchment/80">
            {summary.totalRows} row{summary.totalRows === 1 ? "" : "s"}:{" "}
            <span className="text-claw-green">{summary.enqueued} enqueued</span>,{" "}
            <span className="text-signal-teal">{summary.duplicates} already imported</span>,{" "}
            {summary.unmatched} matched no flow
            {summary.skipped > 0 ? `, ${summary.skipped} empty` : ""}
          </p>
          {summary.errors.length > 0 && (
            <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
              {summary.errors.map((err, i) => (
                <li key={i} className="text-[11px] text-red-300">
                  Row {err.row}: {err.message}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[11px] text-parchment/50">
            Runs release on the schedule you picked —{" "}
            <Link href="/dashboard/aiflows/runs" className="text-signal-teal hover:underline">
              watch them in Runs →
            </Link>
          </p>
        </div>
      )}
    </Card>
  );
}
