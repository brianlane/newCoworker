"use client";

/**
 * Deals board (/dashboard/tasks, Deals view).
 *
 * A status-column board over the business's deals: the four fixed funnel
 * columns (open / under contract / won / lost) instead of the pipeline
 * board's tag-backed stages. Cards show the money view of a lead (title,
 * linked contact, value, expected close); dragging a card between columns
 * PATCHes the status, and the server enforces the funnel rules (a won deal
 * cannot flip straight to lost, it reopens first).
 *
 * Managers (manage_settings) create/edit/delete deals through a small modal
 * editor; staff see the board read-only. Data loads client-side from
 * /api/dashboard/deals, contact search for linking from
 * /api/dashboard/customers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Pencil, Plus, RefreshCw, User, X } from "lucide-react";
import { Card } from "@/components/ui/Card";
import {
  DEAL_STATUSES,
  MAX_DEAL_TITLE_LENGTH,
  applyDealStatusToList,
  formatCommissionBps,
  formatDealValue,
  type Deal,
  type DealStatus
} from "@/lib/deals/core";
import type { DealWithContact } from "@/lib/deals/db";

/** Column accents, same palette treatment as the pipeline board. */
const STATUS_CLASSES: Record<DealStatus, { dot: string; border: string; bg: string }> = {
  open: { dot: "bg-sky-400", border: "border-t-sky-400/60", bg: "bg-sky-400/10" },
  under_contract: {
    dot: "bg-amber-400",
    border: "border-t-amber-400/60",
    bg: "bg-amber-400/10"
  },
  won: { dot: "bg-green-400", border: "border-t-green-400/60", bg: "bg-green-400/10" },
  lost: { dot: "bg-slate-400", border: "border-t-slate-400/60", bg: "bg-slate-400/10" }
};

type ApiEnvelope<T> = { ok: boolean; data?: T; error?: { message?: string } };

async function readEnvelope<T>(res: Response): Promise<T> {
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.ok || !json.data) {
    throw new Error(json.error?.message ?? "Request failed");
  }
  return json.data;
}

/** "2026-09-15" → "Sep 15" (year appended when it isn't the current one). */
function shortCloseDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC"
  });
}

type EditorState =
  | { mode: "create" }
  | { mode: "edit"; deal: DealWithContact };

export function DealsBoard({
  businessId,
  canManage
}: {
  businessId: string;
  canManage: boolean;
}) {
  const t = useTranslations("dashboard.deals");
  const [deals, setDeals] = useState<DealWithContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<DealStatus | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetch(
        `/api/dashboard/deals?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      ).then((r) => readEnvelope<{ deals: DealWithContact[] }>(r));
      setDeals(data.deals);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("loadFailed"));
      setDeals(null);
    } finally {
      setLoading(false);
    }
  }, [businessId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns = useMemo(() => {
    const map = new Map<DealStatus, DealWithContact[]>(
      DEAL_STATUSES.map((s) => [s, []])
    );
    for (const deal of deals ?? []) map.get(deal.status)?.push(deal);
    return map;
  }, [deals]);

  const statusLabel: Record<DealStatus, string> = {
    open: t("statusOpen"),
    under_contract: t("statusUnderContract"),
    won: t("statusWon"),
    lost: t("statusLost")
  };

  const moveDeal = useCallback(
    async (dealId: string, status: DealStatus) => {
      if (!deals) return;
      const deal = deals.find((d) => d.id === dealId);
      if (!deal || deal.status === status) return;
      setMoveError(null);
      const previousStatus = deal.status;
      // Optimistic move; the server response carries the authoritative
      // stamps (won_at/lost_at) so a reload isn't needed on success.
      // Per DEAL, never a whole-array snapshot: a second drag can land while
      // this PATCH is in flight, and both this write and the rollback below
      // must leave that other deal alone.
      setDeals((ds) => applyDealStatusToList(ds, dealId, status));
      try {
        const data = await fetch(
          `/api/dashboard/deals/${encodeURIComponent(dealId)}?businessId=${encodeURIComponent(businessId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status })
          }
        ).then((r) => readEnvelope<{ deal: Deal }>(r));
        setDeals((ds) =>
          ds
            ? ds.map((d) =>
                d.id === dealId
                  ? { ...data.deal, contactE164: d.contactE164, contactName: d.contactName }
                  : d
              )
            : ds
        );
      } catch (e) {
        setDeals((ds) => applyDealStatusToList(ds, dealId, previousStatus));
        setMoveError(e instanceof Error ? e.message : t("moveFailed"));
      }
    },
    [businessId, deals, t]
  );

  if (error) {
    return (
      <Card>
        <p className="text-sm text-spark-orange">{error}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/60 hover:text-parchment"
            aria-label={t("refresh")}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("refresh")}
          </button>
          {canManage && (
            <button
              onClick={() => setEditor({ mode: "create" })}
              className="inline-flex items-center gap-1.5 rounded-lg bg-claw-green px-3 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-claw-green/90"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("newDeal")}
            </button>
          )}
        </div>
      </div>

      {moveError && (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-spark-orange">{moveError}</p>
            <button
              onClick={() => setMoveError(null)}
              className="text-parchment/40 hover:text-parchment"
              aria-label={t("dismiss")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </Card>
      )}

      {deals !== null && deals.length === 0 && (
        <Card>
          <div className="space-y-3 py-4 text-center">
            <p className="text-sm text-parchment/60">{t("empty")}</p>
            {!canManage && (
              <p className="text-xs text-parchment/40">{t("askManager")}</p>
            )}
          </div>
        </Card>
      )}

      <div className="flex items-start gap-3 overflow-x-auto rounded-lg border border-parchment/10 bg-parchment/5 p-3">
        {DEAL_STATUSES.map((status) => {
          const cards = columns.get(status) ?? [];
          const colors = STATUS_CLASSES[status];
          return (
            <div
              key={status}
              onDragOver={(e) => {
                if (!canManage) return;
                e.preventDefault();
                setDragOverStatus(status);
              }}
              onDragLeave={() => setDragOverStatus((s) => (s === status ? null : s))}
              onDrop={(e) => {
                if (!canManage) return;
                e.preventDefault();
                setDragOverStatus(null);
                const dealId = e.dataTransfer.getData("text/plain");
                if (dealId) void moveDeal(dealId, status);
              }}
              className={`w-72 shrink-0 rounded-lg border border-t-2 transition-colors ${colors.border} ${colors.bg} ${
                dragOverStatus === status
                  ? "border-signal-teal/60 ring-1 ring-signal-teal/40"
                  : "border-parchment/10"
              }`}
            >
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${colors.dot}`} />
                <span className="truncate text-xs font-semibold text-parchment/80">
                  {statusLabel[status]}
                </span>
                <span className="rounded-full bg-parchment/10 px-1.5 py-0.5 text-[10px] text-parchment/50">
                  {cards.length}
                </span>
              </div>
              <div className="space-y-2 px-2 pb-2">
                {cards.length === 0 && (
                  <p className="px-1 py-3 text-center text-[11px] text-parchment/30">
                    {t("emptyColumn")}
                  </p>
                )}
                {cards.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    canManage={canManage}
                    onEdit={() => setEditor({ mode: "edit", deal })}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {editor && (
        <DealEditorModal
          businessId={businessId}
          editor={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function DealCard({
  deal,
  canManage,
  onEdit
}: {
  deal: DealWithContact;
  canManage: boolean;
  onEdit: () => void;
}) {
  const t = useTranslations("dashboard.deals");
  const value = formatDealValue(deal.valueCents, deal.currency);
  return (
    <div
      draggable={canManage}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", deal.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={`rounded-md border border-parchment/10 bg-deep-ink/60 p-2.5 hover:border-parchment/25 ${
        canManage ? "cursor-grab active:cursor-grabbing" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-semibold text-parchment" title={deal.title}>
          {deal.title}
        </span>
        {canManage && (
          <button
            type="button"
            data-testid="deal-card-edit"
            onClick={onEdit}
            className="ml-auto shrink-0 text-parchment/30 hover:text-signal-teal"
            aria-label={t("editDeal")}
            title={t("editDeal")}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      <p className="mt-0.5 truncate text-[11px] text-parchment/50">
        {deal.contactE164 ? (
          <Link
            href={`/dashboard/customers/${encodeURIComponent(deal.contactE164)}`}
            className="inline-flex items-center gap-1 hover:text-signal-teal hover:underline"
            title={deal.contactName ?? deal.contactE164}
          >
            <User className="h-3 w-3" />
            {deal.contactName ?? deal.contactE164}
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 text-parchment/30">
            <User className="h-3 w-3" />
            {t("noContact")}
          </span>
        )}
      </p>
      <div className="mt-1.5 flex items-center justify-between text-[11px]">
        <span className="font-medium text-parchment/80">{value ?? ""}</span>
        {deal.expectedCloseDate && (
          <span className="text-parchment/40">
            {t("closes", { date: shortCloseDate(deal.expectedCloseDate) })}
          </span>
        )}
      </div>
      {deal.commissionBps !== null && (
        <p className="mt-0.5 text-[10px] text-parchment/40">
          {t("commissionShort", { pct: formatCommissionBps(deal.commissionBps) })}
        </p>
      )}
    </div>
  );
}

type ContactHit = { id: string; customerE164: string; displayName: string | null };

/**
 * Create / edit a deal in a modal, the same overlay treatment as the
 * pipeline board's quick editor. Contact linking is a small typeahead over
 * /api/dashboard/customers.
 */
function DealEditorModal({
  businessId,
  editor,
  onClose,
  onSaved
}: {
  businessId: string;
  editor: EditorState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("dashboard.deals");
  const existing = editor.mode === "edit" ? editor.deal : null;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [valueText, setValueText] = useState(
    existing?.valueCents !== null && existing?.valueCents !== undefined
      ? String(existing.valueCents / 100)
      : ""
  );
  const [commissionText, setCommissionText] = useState(
    existing?.commissionBps !== null && existing?.commissionBps !== undefined
      ? String(existing.commissionBps / 100)
      : ""
  );
  const [closeDate, setCloseDate] = useState(existing?.expectedCloseDate ?? "");
  const [status, setStatus] = useState<DealStatus>(existing?.status ?? "open");
  const [contactId, setContactId] = useState<string | null>(existing?.contactId ?? null);
  const [contactLabel, setContactLabel] = useState<string | null>(
    existing ? existing.contactName ?? existing.contactE164 : null
  );
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const statusLabel: Record<DealStatus, string> = {
    open: t("statusOpen"),
    under_contract: t("statusUnderContract"),
    won: t("statusWon"),
    lost: t("statusLost")
  };

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = search.trim();
    if (!q) {
      setHits([]);
      return;
    }
    searchTimer.current = setTimeout(() => {
      void fetch(
        `/api/dashboard/customers?businessId=${encodeURIComponent(businessId)}&search=${encodeURIComponent(q)}&limit=8`,
        { cache: "no-store" }
      )
        .then((r) => readEnvelope<{ customers: ContactHit[] }>(r))
        .then((data) => setHits(data.customers))
        .catch(() => setHits([]));
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search, businessId]);

  const save = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setFormError(t("titleRequired"));
      return;
    }
    const valueRaw = valueText.trim().replace(/[$,\s]/g, "");
    let valueCents: number | null = null;
    if (valueRaw) {
      const parsed = Number(valueRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setFormError(t("invalidValue"));
        return;
      }
      valueCents = Math.round(parsed * 100);
    }
    const commissionRaw = commissionText.trim().replace(/[%\s]/g, "");
    let commissionBps: number | null = null;
    if (commissionRaw) {
      const parsed = Number(commissionRaw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        setFormError(t("invalidCommission"));
        return;
      }
      commissionBps = Math.round(parsed * 100);
    }

    setBusy(true);
    setFormError(null);
    const body = {
      title: trimmed,
      contactId,
      valueCents,
      commissionBps,
      expectedCloseDate: closeDate || null,
      status
    };
    try {
      if (existing) {
        await fetch(
          `/api/dashboard/deals/${encodeURIComponent(existing.id)}?businessId=${encodeURIComponent(businessId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          }
        ).then((r) => readEnvelope<unknown>(r));
      } else {
        await fetch(`/api/dashboard/deals?businessId=${encodeURIComponent(businessId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }).then((r) => readEnvelope<unknown>(r));
      }
      onSaved();
    } catch (e) {
      setFormError(
        e instanceof Error ? e.message : existing ? t("saveFailed") : t("createFailed")
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!existing) return;
    if (!window.confirm(t("deleteConfirm", { title: existing.title }))) return;
    setBusy(true);
    setFormError(null);
    try {
      await fetch(
        `/api/dashboard/deals/${encodeURIComponent(existing.id)}?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE", headers: { "Content-Type": "application/json" } }
      ).then((r) => readEnvelope<unknown>(r));
      onSaved();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t("deleteFailed"));
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-sm text-parchment placeholder:text-parchment/30";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={existing ? t("editDeal") : t("newDeal")}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-parchment/15 bg-deep-ink p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-parchment">
            {existing ? t("editDeal") : t("newDeal")}
          </h3>
          <button
            onClick={onClose}
            className="text-parchment/40 hover:text-parchment"
            aria-label={t("editCancel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          {formError && <p className="text-sm text-spark-orange">{formError}</p>}

          <div>
            <label className="mb-1 block text-xs font-medium text-parchment/60" htmlFor="deal-title">
              {t("editTitle")}
            </label>
            <input
              id="deal-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={MAX_DEAL_TITLE_LENGTH}
              placeholder={t("titlePlaceholder")}
              className={inputClass}
            />
          </div>

          <div>
            <span className="mb-1 block text-xs font-medium text-parchment/60">
              {t("editContact")}
            </span>
            {contactId ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-parchment/10 px-2 py-1 text-xs text-parchment/80">
                  <User className="h-3 w-3" />
                  {contactLabel}
                </span>
                <button
                  onClick={() => {
                    setContactId(null);
                    setContactLabel(null);
                  }}
                  className="text-parchment/40 hover:text-parchment"
                  aria-label={t("clearContact")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("contactSearchPlaceholder")}
                  className={inputClass}
                  aria-label={t("editContact")}
                />
                {hits.length > 0 && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-parchment/15">
                    {hits.map((hit) => (
                      <button
                        key={hit.id}
                        onClick={() => {
                          setContactId(hit.id);
                          setContactLabel(hit.displayName ?? hit.customerE164);
                          setSearch("");
                          setHits([]);
                        }}
                        className="block w-full truncate px-2 py-1.5 text-left text-xs text-parchment/80 hover:bg-parchment/10"
                      >
                        {hit.displayName ?? hit.customerE164}
                        {hit.displayName ? (
                          <span className="text-parchment/40"> · {hit.customerE164}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-parchment/60" htmlFor="deal-value">
                {t("editValue")}
              </label>
              <input
                id="deal-value"
                value={valueText}
                onChange={(e) => setValueText(e.target.value)}
                placeholder="12500"
                inputMode="decimal"
                className={inputClass}
              />
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium text-parchment/60"
                htmlFor="deal-commission"
              >
                {t("editCommission")}
              </label>
              <input
                id="deal-commission"
                value={commissionText}
                onChange={(e) => setCommissionText(e.target.value)}
                placeholder="2.5"
                inputMode="decimal"
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-parchment/60" htmlFor="deal-close">
                {t("editCloseDate")}
              </label>
              <input
                id="deal-close"
                type="date"
                value={closeDate}
                onChange={(e) => setCloseDate(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-parchment/60" htmlFor="deal-status">
                {t("editStatus")}
              </label>
              <select
                id="deal-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as DealStatus)}
                className={inputClass}
              >
                {DEAL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            {existing ? (
              <button
                onClick={() => void remove()}
                disabled={busy}
                className="rounded-md border border-spark-orange/40 px-2.5 py-1.5 text-xs text-spark-orange hover:bg-spark-orange/10 disabled:opacity-40"
              >
                {t("editDelete")}
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                disabled={busy}
                className="rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/60 hover:text-parchment disabled:opacity-40"
              >
                {t("editCancel")}
              </button>
              <button
                onClick={() => void save()}
                disabled={busy || !title.trim()}
                className="rounded-lg bg-claw-green px-4 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-claw-green/90 disabled:opacity-50"
              >
                {busy ? t("editSaving") : t("editSave")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
