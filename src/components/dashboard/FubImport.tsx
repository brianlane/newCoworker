"use client";

/**
 * "Import from Follow Up Boss" card on /dashboard/import-export.
 *
 * Flow: paste the FUB API key (password field, never echoed back), run the
 * DRY RUN (counts + a smart-list / action-plan inventory, nothing written),
 * then confirm to run the real import. The run endpoint works in resumable
 * chunks, so this component keeps POSTing /run until the job reports done,
 * polling GET status in between for live progress. A "delete saved key"
 * button wipes the stored (encrypted) key while keeping the result report.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { CloudDownload, KeyRound, Trash2 } from "lucide-react";

type Props = { businessId: string };

type DryRunCounts = {
  people: number | null;
  notes: number | null;
  deals: number | null;
  stages: { name: string; peopleCount: number | null }[];
  smartLists: string[];
  actionPlans: { name: string; status: string | null }[];
  sourcesSample: string[];
};

type RunCounts = {
  contactsCreated: number;
  contactsUpdated: number;
  contactsSkipped: number;
  notesImported: number;
  notesSkipped: number;
  dealsImported: number;
  dealsSkipped: number;
  failureCount: number;
  failures: { scope: string; reason: string }[];
};

type PublicJob = {
  id: string;
  status: "pending" | "dry_run_done" | "running" | "done" | "failed";
  dryRun: boolean;
  hasApiKey: boolean;
  counts: { dryRun?: DryRunCounts; run?: RunCounts };
  progress: { phase: string; offset: number };
  error: string | null;
};

type ApiError = { error?: { message?: string } };

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as ApiError | null;
  return json?.error?.message || `HTTP ${res.status}`;
}

const STATUS_POLL_MS = 4000;

export function FubImport({ businessId }: Props) {
  const t = useTranslations("dashboard.fubImport");
  const [job, setJob] = useState<PublicJob | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"dryRun" | "run" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyDeleted, setKeyDeleted] = useState(false);
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

  async function runDryRun() {
    if (!apiKey.trim()) {
      setError(t("keyMissing"));
      return;
    }
    setBusy("dryRun");
    setError(null);
    setKeyDeleted(false);
    try {
      const res = await fetch("/api/dashboard/import/fub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, apiKey: apiKey.trim() })
      });
      if (!res.ok) throw new Error(await readError(res));
      const json = (await res.json()) as { data?: { job?: PublicJob } };
      if (json.data?.job) setJob(json.data.job);
      // The key now lives encrypted on the server; drop it from the browser.
      setApiKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runImport(jobId: string) {
    setBusy("run");
    setError(null);
    const poll = setInterval(() => void refresh(), STATUS_POLL_MS);
    try {
      // Each POST imports as much as its time budget allows and persists a
      // cursor; keep calling until the job reports done.
      for (;;) {
        const res = await fetch("/api/dashboard/import/fub/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ businessId, jobId })
        });
        if (!res.ok) throw new Error(await readError(res));
        const json = (await res.json()) as {
          data?: { status?: string; job?: PublicJob | null };
        };
        if (json.data?.job && !stopped.current) setJob(json.data.job);
        if (stopped.current || json.data?.status !== "running") break;
      }
    } catch (e) {
      if (!stopped.current) setError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      clearInterval(poll);
      if (!stopped.current) setBusy(null);
    }
  }

  async function deleteKey(jobId: string) {
    setBusy("delete");
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/import/fub?businessId=${encodeURIComponent(businessId)}&jobId=${encodeURIComponent(jobId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error(await readError(res));
      setKeyDeleted(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const dryRun = job?.counts.dryRun;
  const run = job?.counts.run;
  const running = busy === "run" || job?.status === "running";
  // Resume offer, matching what the run endpoint accepts: a failed REAL run
  // still has a valid cursor, while a job that never got past its preview
  // (dryRun still true, because the server flips it the moment a real run
  // starts) has nothing to resume and has to be started again.
  const canRun =
    !!job &&
    job.hasApiKey &&
    (job.status === "dry_run_done" ||
      job.status === "running" ||
      (job.status === "failed" && !job.dryRun));
  const phaseLabel = (phase: string) =>
    phase === "people"
      ? t("phasePeople")
      : phase === "notes"
        ? t("phaseNotes")
        : phase === "deals"
          ? t("phaseDeals")
          : t("phaseDone");

  return (
    <Card>
      <h3 className="text-sm font-semibold text-parchment flex items-center gap-2">
        <CloudDownload className="h-4 w-4" />
        {t("title")}
      </h3>
      <p className="text-xs text-parchment/50 mt-1 mb-4">{t("blurb")}</p>

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
          <span className="block text-xs text-parchment/70 mb-1">{t("keyLabel")}</span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("keyPlaceholder")}
            className="w-full rounded-lg bg-deep-ink/60 border border-parchment/20 px-3 py-2 text-xs text-parchment placeholder:text-parchment/30"
          />
        </label>
        <button
          type="button"
          onClick={() => void runDryRun()}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg bg-signal-teal text-deep-ink px-3 py-2 text-xs font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40"
        >
          <KeyRound className="h-3.5 w-3.5" />
          {busy === "dryRun" ? t("dryRunRunning") : t("dryRunButton")}
        </button>
      </div>
      <p className="text-[11px] text-parchment/40 mt-2">{t("keyHelp")}</p>

      {dryRun && (
        <div className="mt-4 rounded-lg border border-parchment/10 bg-deep-ink/40 px-3 py-3 space-y-2">
          <p className="text-xs font-semibold text-parchment">{t("dryRunTitle")}</p>
          <div className="overflow-x-auto">
            <table className="text-xs text-parchment/80">
              <tbody>
                <tr>
                  <td className="pr-4 py-0.5">{t("dryRunPeople")}</td>
                  <td className="text-right">{dryRun.people ?? "?"}</td>
                </tr>
                <tr>
                  <td className="pr-4 py-0.5">{t("dryRunNotes")}</td>
                  <td className="text-right">{dryRun.notes ?? "?"}</td>
                </tr>
                <tr>
                  <td className="pr-4 py-0.5">{t("dryRunDeals")}</td>
                  <td className="text-right">{dryRun.deals ?? "?"}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {dryRun.stages.length > 0 && (
            <p className="text-[11px] text-parchment/60">
              {t("dryRunStages")}:{" "}
              {dryRun.stages
                .map((s) => `${s.name}${s.peopleCount !== null ? ` (${s.peopleCount})` : ""}`)
                .join(", ")}
            </p>
          )}
          {dryRun.sourcesSample.length > 0 && (
            <p className="text-[11px] text-parchment/60">
              {t("dryRunSources")}: {dryRun.sourcesSample.join(", ")}
            </p>
          )}
          {dryRun.smartLists.length > 0 && (
            <p className="text-[11px] text-parchment/60">
              {t("dryRunSmartLists")}: {dryRun.smartLists.join(", ")}
            </p>
          )}
          {dryRun.actionPlans.length > 0 && (
            <p className="text-[11px] text-parchment/60">
              {t("dryRunActionPlans")}:{" "}
              {dryRun.actionPlans.map((p) => p.name).join(", ")}
            </p>
          )}
          <p className="text-[11px] text-parchment/40">{t("inventoryNote")}</p>
        </div>
      )}

      {job && canRun && (
        <div className="mt-4 space-y-2">
          <button
            type="button"
            onClick={() => void runImport(job.id)}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-claw-green text-deep-ink px-3 py-2 text-xs font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40"
          >
            <CloudDownload className="h-3.5 w-3.5" />
            {running
              ? t("runRunning")
              : job.status === "failed"
                ? t("resumeButton")
                : t("runButton")}
          </button>
          <p className="text-[11px] text-parchment/40">{t("automationsNote")}</p>
          {running && (
            <p className="text-xs text-signal-teal">
              {t("progress", {
                phase: phaseLabel(job.progress.phase),
                count: job.progress.offset
              })}
            </p>
          )}
        </div>
      )}

      {run && (job?.status === "done" || run.contactsCreated + run.contactsUpdated > 0) && (
        <div className="mt-4 rounded-lg border border-parchment/10 bg-deep-ink/40 px-3 py-3 space-y-1">
          <p className="text-xs font-semibold text-parchment">
            {job?.status === "done" ? t("resultTitleDone") : t("resultTitleProgress")}
          </p>
          <p className="text-xs text-parchment/80">
            {t("resultContacts", {
              created: run.contactsCreated,
              updated: run.contactsUpdated,
              skipped: run.contactsSkipped
            })}
          </p>
          <p className="text-xs text-parchment/80">
            {t("resultNotes", { imported: run.notesImported, skipped: run.notesSkipped })}
          </p>
          <p className="text-xs text-parchment/80">
            {t("resultDeals", { imported: run.dealsImported, skipped: run.dealsSkipped })}
          </p>
          {run.failureCount > 0 && (
            <div className="pt-1">
              <p className="text-[11px] text-red-300">
                {t("failuresTitle", { count: run.failureCount })}
              </p>
              <ul className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                {run.failures.map((f, i) => (
                  <li key={i} className="text-[11px] text-red-300/80">
                    {f.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {job?.hasApiKey && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => void deleteKey(job.id)}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/40 text-red-300 px-3 py-2 text-xs hover:bg-red-400/10 transition-colors disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {busy === "delete" ? t("deleteKeyDeleting") : t("deleteKeyButton")}
          </button>
        </div>
      )}
      {keyDeleted && <p className="text-xs text-claw-green mt-2">{t("deleteKeyDone")}</p>}
    </Card>
  );
}
