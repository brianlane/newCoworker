"use client";

/**
 * Prospecting panel (Dashboard → Marketing).
 *
 * The owner's switch and scoreboard for outbound outreach. Three things live
 * here, in the order they matter:
 *
 *   1. The mode. Off, manual review, or fully automatic. Off is the default and
 *      the kill switch, and it takes effect on the next sweep pass.
 *   2. The numbers, in the vocabulary that cannot mislead: drafted and sent are
 *      separate, drafts waiting on you are called waiting, and the reply rate is
 *      a share of what was actually sent.
 *   3. The review queue, in manual mode: read the draft, then Send or Skip.
 *
 * Blockers are shown whether the feature is on or off, so "why is nothing
 * happening?" is answered on the page rather than in a support conversation.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

type Mode = "off" | "manual" | "auto";

type QueueAction = "send" | "skip" | "edit" | "regenerate";

type Settings = {
  mode: Mode;
  search_terms: string[];
  cities: string[];
  daily_cap: number;
  send_window_start_hour: number;
  send_window_end_hour: number;
  postal_address: string | null;
  value_prop: string | null;
  sender_name: string | null;
};

type Funnel = {
  discovered: number;
  drafted: number;
  pending: number;
  sent: number;
  replied: number;
  booked: number;
  unsubscribed: number;
  skipped: number;
  failed: number;
  replyRate: number;
};

type VerticalFunnel = Funnel & { vertical: string };

type QueueItem = {
  id: string;
  business_name: string;
  domain: string;
  city: string;
  vertical: string;
  email: string | null;
  pitch_subject: string | null;
  /**
   * The editable middle of the draft. Null on drafts written before editing
   * existed: those can be regenerated, but there is nothing safe to hand the
   * owner to edit, since only the assembled body was ever stored and it
   * carries the compliance footer.
   */
  pitch_paragraphs: string | null;
  pitch_body: string | null;
};

type View = {
  settings: Settings | null;
  funnel: Funnel;
  byVertical: VerticalFunnel[];
  queue: QueueItem[];
  /** The outcome scan hit its bound, so the numbers are floors. */
  clipped: boolean;
  blockers: string[];
  /** False on Starter: show the upgrade card instead of the controls. */
  tierAllowed: boolean;
  /** False on Enterprise: the footer address is optional here. */
  postalAddressRequired: boolean;
};

const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none";
const labelClass = "block text-xs font-medium text-parchment/60 mb-1";

const DEFAULTS: Settings = {
  mode: "off",
  search_terms: [],
  cities: [],
  daily_cap: 12,
  send_window_start_hour: 8,
  send_window_end_hour: 11,
  postal_address: null,
  value_prop: null,
  sender_name: null
};

export function ProspectingPanel({ businessId }: { businessId: string }) {
  const t = useTranslations("dashboard.prospecting");
  const [view, setView] = useState<View | null>(null);
  const [form, setForm] = useState<Settings>(DEFAULTS);
  const [terms, setTerms] = useState("");
  const [cities, setCities] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  /**
   * Draft edits in progress, per prospect. Kept out of `view` for the same
   * reason the settings form is: Send, Skip, and Regenerate all re-read from
   * the server, and a refresh must not overwrite something half-typed.
   */
  const [drafts, setDrafts] = useState<Record<string, { subject: string; paragraphs: string }>>({});
  /**
   * Unsaved edits in the form. Send and Skip both re-read from the server, so
   * without this a targeting change typed while working through the queue
   * would be silently overwritten by the refresh that follows. Mirrored into a
   * ref because refresh reads it from inside a stable callback, including the
   * one on mount that can land after the owner has already started typing.
   */
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  /**
   * The bulk rewrite, which is a loop rather than one call: the server rewrites
   * a batch per request and hands back a cursor, so progress has to live here.
   * `null` means idle, "confirm" means the warning is on screen and nothing has
   * been spent yet.
   */
  const [bulk, setBulk] = useState<null | "confirm" | { done: number; total: number }>(null);
  const bulkRunning = bulk !== null && bulk !== "confirm";
  /**
   * The same fact as `bulkRunning`, readable synchronously. Two clicks landing
   * in one frame both see the pre-render state, and a second loop would open
   * its own cursor and rewrite the same drafts again, at a second model call
   * each. `setState` cannot stop that; a ref can.
   */
  const bulkRunningRef = useRef(false);
  /** The trade whose "are you sure" is on screen, and the one being retired. */
  const [confirmVertical, setConfirmVertical] = useState<string | null>(null);
  const [skippingVertical, setSkippingVertical] = useState<string | null>(null);

  const markDirty = () => {
    dirtyRef.current = true;
    setDirty(true);
  };

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/dashboard/outreach?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as { ok: boolean; data?: View };
      if (!json.ok || !json.data) return;
      setView(json.data);
      // The queue and the numbers always update; a form with unsaved edits
      // never does.
      if (dirtyRef.current) return;
      const next = json.data.settings ?? DEFAULTS;
      setForm(next);
      setTerms(next.search_terms.join(", "));
      setCities(next.cities.join(", "));
    } catch {
      /* keep whatever is on screen */
    }
  }, [businessId]);

  /** Field edits mark the form dirty so a background refresh cannot clobber them. */
  const edit = (patch: Partial<Settings>) => {
    markDirty();
    setForm((prev) => ({ ...prev, ...patch }));
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (mode: Mode) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/dashboard/outreach", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          mode,
          searchTerms: terms.split(",").map((s) => s.trim()).filter(Boolean),
          cities: cities.split(",").map((s) => s.trim()).filter(Boolean),
          dailyCap: form.daily_cap,
          sendWindowStartHour: form.send_window_start_hour,
          sendWindowEndHour: form.send_window_end_hour,
          postalAddress: form.postal_address ?? "",
          valueProp: form.value_prop ?? "",
          senderName: form.sender_name ?? ""
        })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? t("saveFailed"));
        return;
      }
      setNotice(t("saved"));
      dirtyRef.current = false;
      setDirty(false);
      await refresh();
    } catch {
      setError(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const NOTICE_BY_ACTION: Record<QueueAction, string> = {
    send: t("sentOne"),
    skip: t("skippedOne"),
    edit: t("editedOne"),
    regenerate: t("regeneratedOne")
  };

  const act = async (prospectId: string, action: QueueAction) => {
    setBusyId(prospectId);
    setError(null);
    setNotice(null);
    try {
      const edit = action === "edit" ? drafts[prospectId] : undefined;
      const res = await fetch(`/api/dashboard/outreach/prospects/${prospectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          action,
          subject: edit?.subject,
          paragraphs: edit?.paragraphs
        })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? t("actionFailed"));
        return;
      }
      setNotice(NOTICE_BY_ACTION[action]);
      // The server now holds this draft's text, so the local copy is dropped
      // and the refresh below reseeds the editor from what was actually saved.
      // Regenerate discards it for the same reason: the coworker's new writing
      // is the answer to pressing that button.
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[prospectId];
        return next;
      });
      // Refreshes the queue and the numbers; a half-typed settings form is
      // left alone, since the owner did not ask to discard it by pressing Send.
      await refresh();
    } catch {
      setError(t("actionFailed"));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Write every waiting draft again, batch by batch.
   *
   * The queue on screen is capped at 25 while a busy tenant can have hundreds
   * waiting, so this counts against the funnel's pending number rather than the
   * rows rendered. The server decides when the run is finished (`remaining`
   * reaching zero); the count here only feeds the progress line, so a draft the
   * sweep sends mid-run cannot strand the loop.
   */
  const rewriteAll = async () => {
    if (bulkRunningRef.current) return;
    bulkRunningRef.current = true;
    const total = view?.funnel.pending ?? 0;
    setBulk({ done: 0, total });
    setError(null);
    setNotice(null);
    let since: string | undefined;
    let done = 0;
    try {
      for (;;) {
        const res = await fetch("/api/dashboard/outreach/rewrite-all", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ businessId, since })
        });
        const json = (await res.json()) as {
          ok: boolean;
          data?: { startedAt: string; rewritten: number; skipped: number; remaining: number };
          error?: { message?: string };
        };
        if (!json.ok || !json.data) {
          setError(json.error?.message ?? t("actionFailed"));
          return;
        }
        since = json.data.startedAt;
        done += json.data.rewritten + json.data.skipped;
        setBulk({ done, total: Math.max(total, done) });
        if (json.data.remaining <= 0) break;
        // A batch that reached nothing at all cannot be repeated usefully: the
        // count says work is left but the read found none of it. Stopping beats
        // spinning on the same empty slice.
        if (json.data.rewritten + json.data.skipped === 0) break;
      }
      setNotice(t("rewroteAll", { count: done }));
    } catch {
      setError(t("actionFailed"));
    } finally {
      // Re-read on EVERY exit, including the failed ones. A run that dies in
      // the middle has still replaced the drafts of every batch that finished,
      // so returning without this would leave the queue showing pre-rewrite
      // copy over rewritten rows, with Send re-enabled above it: the owner
      // reads the old email and dispatches the new one. Dropping the local
      // edits goes with it, for the same reason.
      setDrafts({});
      await refresh();
      setBulk(null);
      bulkRunningRef.current = false;
    }
  };

  /**
   * Call off a whole trade.
   *
   * Taking a term out of "Kinds of business to look for" only stops the next
   * discovery pass; everything that term already found is still queued, and in
   * automatic mode still goes out. This retires all of it. The server reports
   * how many it caught, which is the number worth showing: the row's own count
   * includes prospects that were already sent, and those are left alone.
   */
  const skipVertical = async (vertical: string) => {
    setSkippingVertical(vertical);
    setConfirmVertical(null);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/dashboard/outreach/verticals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, vertical })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { skipped: number };
        error?: { message?: string };
      };
      if (!json.ok || !json.data) {
        setError(json.error?.message ?? t("actionFailed"));
        return;
      }
      setNotice(t("skippedVertical", { count: json.data.skipped, vertical }));
    } catch {
      setError(t("actionFailed"));
    } finally {
      // Always re-read: the queue below is showing drafts this may have just
      // retired, and leaving Send live over them is how a called-off trade
      // still gets emailed.
      setDrafts({});
      await refresh();
      setSkippingVertical(null);
    }
  };

  /**
   * A draft with no stored paragraphs: written before the column existed, or
   * read back by a build that is briefly ahead of the migration. Both get the
   * read-only treatment, which is the safe failure: the alternative is an
   * empty edit box over a pitch the owner can still see underneath it.
   */
  const isLegacyDraft = (item: QueueItem) => !item.pitch_paragraphs;

  /** The editor's current text: the owner's unsaved edit, or what is stored. */
  const draftText = (item: QueueItem) =>
    drafts[item.id] ?? {
      subject: item.pitch_subject ?? "",
      paragraphs: item.pitch_paragraphs ?? ""
    };

  const editDraft = (item: QueueItem, patch: { subject?: string; paragraphs?: string }) => {
    const current = draftText(item);
    setDrafts((prev) => ({ ...prev, [item.id]: { ...current, ...patch } }));
  };

  const funnel = view?.funnel;
  const mode = view?.settings?.mode ?? "off";
  // Defaults to required until the view loads, so the stricter copy is what a
  // slow first paint shows.
  const postalRequired = view?.postalAddressRequired !== false;

  if (view && !view.tierAllowed) {
    return (
      <Card className="p-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-parchment">{t("title")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-parchment/60">{t("upgradeBody")}</p>
        </div>
        <a
          href="/pricing"
          className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
        >
          {t("upgradeCta")}
        </a>
      </Card>
    );
  }

  return (
    <Card className="p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-parchment">{t("title")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-parchment/60">{t("intro")}</p>
        </div>
        <span className="rounded-full border border-parchment/20 px-3 py-1 text-xs text-parchment/70">
          {t(`mode.${mode}`)}
        </span>
      </div>

      {error ? (
        <p className="rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-md border border-claw-green/40 bg-claw-green/10 px-3 py-2 text-sm text-claw-green">
          {notice}
        </p>
      ) : null}

      {view && view.blockers.length > 0 ? (
        <div className="rounded-md border border-amber-300/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          <p className="font-medium">{t("blockersTitle")}</p>
          <ul className="mt-1 list-disc pl-5">
            {view.blockers.map((b) => (
              <li key={b}>{t(`blockers.${b}`)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {funnel ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {(
            [
              ["discovered", funnel.discovered],
              ["drafted", funnel.drafted],
              ["waiting", funnel.pending],
              ["sent", funnel.sent],
              ["replied", funnel.replied],
              ["booked", funnel.booked]
            ] as const
          ).map(([key, value]) => (
            <div key={key} className="rounded-md border border-parchment/10 bg-deep-ink/30 p-3">
              <p className="text-xs text-parchment/50">{t(`stats.${key}`)}</p>
              <p className="text-lg font-semibold text-parchment">{value}</p>
            </div>
          ))}
        </div>
      ) : null}

      {funnel && funnel.sent > 0 ? (
        <p className="text-xs text-parchment/50">
          {t("replyRate", { rate: Math.round(funnel.replyRate * 100) })}
        </p>
      ) : null}
      {view?.clipped ? (
        <p className="text-xs text-parchment/45">{t("clipped")}</p>
      ) : null}
      {funnel && funnel.pending > 0 && mode === "manual" ? (
        <p className="text-xs text-parchment/60">{t("waitingOnYou", { count: funnel.pending })}</p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="prospecting-terms">
            {t("fields.searchTerms")}
          </label>
          <input
            id="prospecting-terms"
            className={inputClass}
            value={terms}
            onChange={(e) => {
              markDirty();
              setTerms(e.target.value);
            }}
            placeholder={t("placeholders.searchTerms")}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="prospecting-cities">
            {t("fields.cities")}
          </label>
          <input
            id="prospecting-cities"
            className={inputClass}
            value={cities}
            onChange={(e) => {
              markDirty();
              setCities(e.target.value);
            }}
            placeholder={t("placeholders.cities")}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="prospecting-offer">
            {t("fields.valueProp")}
          </label>
          <textarea
            id="prospecting-offer"
            className={`${inputClass} min-h-20`}
            value={form.value_prop ?? ""}
            onChange={(e) => edit({ value_prop: e.target.value })}
            placeholder={t("placeholders.valueProp")}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="prospecting-postal">
            {postalRequired ? t("fields.postalAddress") : t("fields.postalAddressOptional")}
          </label>
          <input
            id="prospecting-postal"
            className={inputClass}
            value={form.postal_address ?? ""}
            onChange={(e) => edit({ postal_address: e.target.value })}
            placeholder={t("placeholders.postalAddress")}
          />
          {/* Enterprise gets the fallback explained rather than a rule stated:
              they can leave this blank, and what lands in the footer instead
              is the thing they will want to know. */}
          <p className="mt-1 text-xs text-parchment/50">
            {postalRequired ? t("postalHelp") : t("postalHelpOptional")}
          </p>
        </div>
        <div>
          <label className={labelClass} htmlFor="prospecting-sender">
            {t("fields.senderName")}
          </label>
          <input
            id="prospecting-sender"
            className={inputClass}
            value={form.sender_name ?? ""}
            onChange={(e) => edit({ sender_name: e.target.value })}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="prospecting-cap">
            {t("fields.dailyCap")}
          </label>
          <input
            id="prospecting-cap"
            type="number"
            min={0}
            max={200}
            className={inputClass}
            value={form.daily_cap}
            onChange={(e) => edit({ daily_cap: Number(e.target.value) })}
          />
          <p className="mt-1 text-xs text-parchment/50">{t("capHelp")}</p>
        </div>
        <div>
          <label className={labelClass} htmlFor="prospecting-start">
            {t("fields.windowStart")}
          </label>
          <input
            id="prospecting-start"
            type="number"
            min={0}
            max={23}
            className={inputClass}
            value={form.send_window_start_hour}
            onChange={(e) =>
              edit({ send_window_start_hour: Number(e.target.value) })
            }
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="prospecting-end">
            {t("fields.windowEnd")}
          </label>
          <input
            id="prospecting-end"
            type="number"
            min={1}
            max={24}
            className={inputClass}
            value={form.send_window_end_hour}
            onChange={(e) => edit({ send_window_end_hour: Number(e.target.value) })}
          />
          <p className="mt-1 text-xs text-parchment/50">{t("windowHelp")}</p>
        </div>
      </div>

      {/* Nothing is savable until the current settings have loaded. Saving
          before then would post the placeholder mode and could switch a
          running Prospecting off by accident. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void save("off")} disabled={saving || !view} variant="secondary">
          {t("actions.turnOff")}
        </Button>
        <Button onClick={() => void save("manual")} disabled={saving || !view} variant="secondary">
          {t("actions.reviewFirst")}
        </Button>
        <Button onClick={() => void save("auto")} disabled={saving || !view}>
          {t("actions.automatic")}
        </Button>
        {/* Saving settings without touching the mode: editing targeting or the
            offer should not require deciding about sending at the same time. */}
        <Button
          onClick={() => void save(mode)}
          disabled={saving || !dirty || !view}
          variant="secondary"
        >
          {t("actions.saveSettings")}
        </Button>
        {dirty ? <span className="text-xs text-amber-200">{t("unsavedChanges")}</span> : null}
      </div>

      {view && view.byVertical.length > 0 ? (
        <div>
          <h3 className="text-sm font-medium text-parchment/80">{t("byVertical")}</h3>
          <p className="mt-1 text-xs text-parchment/50">{t("byVerticalHelp")}</p>
          <div className="mt-2 space-y-1">
            {view.byVertical.map((v) => (
              <div
                key={v.vertical}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-parchment/10 bg-deep-ink/20 px-3 py-2 text-sm"
              >
                <span className="text-parchment/80">{v.vertical}</span>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs text-parchment/60">
                    {t("verticalLine", {
                      drafted: v.drafted,
                      sent: v.sent,
                      replied: v.replied,
                      booked: v.booked
                    })}
                  </span>
                  {/* Two presses, like the bulk rewrite: this retires work in
                      bulk, and the count makes the size of it plain. */}
                  {confirmVertical === v.vertical ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-amber-200">
                        {t("skipVerticalConfirm", { vertical: v.vertical, count: v.pending })}
                      </span>
                      <Button
                        disabled={skippingVertical !== null}
                        onClick={() => void skipVertical(v.vertical)}
                      >
                        {t("actions.skipVerticalYes")}
                      </Button>
                      <Button variant="secondary" onClick={() => setConfirmVertical(null)}>
                        {t("actions.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={skippingVertical !== null || bulkRunning}
                      onClick={() => setConfirmVertical(v.vertical)}
                    >
                      {t("actions.skipVertical")}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {view && view.queue.length > 0 ? (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-parchment/80">
              {t("queueTitle", { count: view.queue.length })}
            </h3>
            {/* Two presses, because one press replaces every draft in the queue
                and spends a model call on each. The warning names the number so
                it is not a surprise. */}
            {bulk === "confirm" ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-amber-200">
                  {t("rewriteAllConfirm", { count: view.funnel.pending })}
                </span>
                <Button disabled={bulkRunning} onClick={() => void rewriteAll()}>
                  {t("actions.rewriteAllYes")}
                </Button>
                <Button variant="secondary" onClick={() => setBulk(null)}>
                  {t("actions.cancel")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {bulkRunning ? (
                  <span className="text-xs text-parchment/60">
                    {t("rewriteAllProgress", { done: bulk.done, total: bulk.total })}
                  </span>
                ) : null}
                <Button
                  variant="secondary"
                  disabled={bulkRunning}
                  onClick={() => setBulk("confirm")}
                >
                  {t("actions.rewriteAll")}
                </Button>
              </div>
            )}
          </div>
          <p className="mt-1 text-xs text-parchment/50">{t("rewriteAllHelp")}</p>
          <div className="mt-2 space-y-2">
            {view.queue.map((item) => (
              <div
                key={item.id}
                className="rounded-md border border-parchment/10 bg-deep-ink/20 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-parchment">
                      {item.business_name || item.domain}
                    </p>
                    <p className="truncate text-xs text-parchment/50">
                      {item.email ?? item.domain}
                      {item.city ? ` · ${item.city}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                    >
                      {expanded === item.id ? t("actions.hide") : t("actions.read")}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busyId === item.id || bulkRunning}
                      onClick={() => void act(item.id, "skip")}
                    >
                      {t("actions.skip")}
                    </Button>
                    {/* Send is blocked while an edit is unsaved: the server
                        would send the stored draft, and the owner would watch
                        their rewrite go out as the old text. */}
                    <Button
                      disabled={busyId === item.id || bulkRunning || Boolean(drafts[item.id])}
                      onClick={() => void act(item.id, "send")}
                    >
                      {t("actions.send")}
                    </Button>
                  </div>
                </div>
                {expanded === item.id ? (
                  <div className="mt-2 space-y-2 rounded border border-parchment/10 bg-deep-ink/40 p-3">
                    {isLegacyDraft(item) ? (
                      // Drafted before the editor existed: only the assembled
                      // body was stored, and handing that back would put the
                      // compliance footer inside an edit box. Regenerate is
                      // the one click that makes it editable.
                      <>
                        <p className="text-xs font-medium text-parchment/70">
                          {item.pitch_subject}
                        </p>
                        <pre className="whitespace-pre-wrap break-words text-xs text-parchment/60">
                          {item.pitch_body}
                        </pre>
                        <p className="text-xs text-parchment/50">{t("legacyDraft")}</p>
                      </>
                    ) : (
                      <>
                        <div>
                          <label className={labelClass} htmlFor={`draft-subject-${item.id}`}>
                            {t("fields.draftSubject")}
                          </label>
                          <input
                            id={`draft-subject-${item.id}`}
                            className={inputClass}
                            value={draftText(item).subject}
                            onChange={(e) => editDraft(item, { subject: e.target.value })}
                          />
                        </div>
                        <div>
                          <label className={labelClass} htmlFor={`draft-body-${item.id}`}>
                            {t("fields.draftBody")}
                          </label>
                          <textarea
                            id={`draft-body-${item.id}`}
                            className={`${inputClass} min-h-40`}
                            value={draftText(item).paragraphs}
                            onChange={(e) => editDraft(item, { paragraphs: e.target.value })}
                          />
                          <p className="mt-1 text-xs text-parchment/50">{t("draftFooterHelp")}</p>
                        </div>
                        {/* The whole email, as stored. The edit boxes hold only
                            the middle, so without this the CTA, the sign-off,
                            the unsubscribe link, and the address are nowhere on
                            screen, and pressing Write it again looks like it
                            deleted most of the email rather than rewording the
                            part the owner can change. */}
                        {item.pitch_body ? (
                          <div>
                            <p className={labelClass}>{t("fields.wholeEmail")}</p>
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-parchment/10 bg-deep-ink/40 p-3 text-xs text-parchment/60">
                              {item.pitch_body}
                            </pre>
                            <p className="mt-1 text-xs text-parchment/50">
                              {drafts[item.id] ? t("wholeEmailStale") : t("wholeEmailHelp")}
                            </p>
                          </div>
                        ) : null}
                      </>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {isLegacyDraft(item) ? null : (
                        <Button
                          variant="secondary"
                          disabled={busyId === item.id || bulkRunning || !drafts[item.id]}
                          onClick={() => void act(item.id, "edit")}
                        >
                          {t("actions.saveDraft")}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        disabled={busyId === item.id || bulkRunning}
                        onClick={() => void act(item.id, "regenerate")}
                      >
                        {t("actions.regenerate")}
                      </Button>
                      {drafts[item.id] ? (
                        <span className="text-xs text-amber-200">{t("unsavedDraft")}</span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
