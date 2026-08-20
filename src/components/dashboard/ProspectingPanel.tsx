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
  from_connection_id: string | null;
  booking_meeting_type_id: string | null;
};

type Funnel = {
  discovered: number;
  drafted: number;
  pending: number;
  /** Prospects that have not gone out: exactly what a per-trade Skip retires. */
  open: number;
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
  /** How many more emails may go out today, from the server's own arithmetic. */
  sendAllowanceLeft: number;
  /** Mailboxes cold email may leave from. Empty means none is connected. */
  mailboxes: Array<{ id: string; label: string; email: string | null }>;
  /** Meetings the CTA can link straight to. Empty when the choice does not apply. */
  meetings: Array<{ id: string; name: string; durationMinutes: number; hidden: boolean }>;
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
  sender_name: null,
  from_connection_id: null,
  booking_meeting_type_id: null
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
   * A row action that failed, shown ON that row.
   *
   * The panel-level banner sits at the top of the card, which is off-screen by
   * the time anyone is working through the queue: pressing Send on the
   * fortieth draft and having the reason appear a thousand pixels above it
   * reads as the button doing nothing at all. Failures belong where the press
   * was.
   */
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  /**
   * The panel-level banner, brought into view when it appears.
   *
   * Send all and the per-trade Skip sit beside the queue, a long way below this
   * banner, so their failures had the same problem the row ones did. Row
   * failures are answered where they happened; these are answered by scrolling
   * to the one place they can live, since a settings error genuinely belongs
   * next to the settings.
   */
  const errorRef = useRef<HTMLParagraphElement | null>(null);
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
  /** The Send all press: null idle, "confirm" warning shown, else progress. */
  const [sendAll, setSendAll] = useState<null | "confirm" | { sent: number }>(null);
  const sendAllRunning = sendAll !== null && sendAll !== "confirm";
  const sendAllRunningRef = useRef(false);
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

  // `nearest` rather than `center`: it scrolls only when the banner is actually
  // off-screen, so an error raised while it is already visible does not yank
  // the page under the owner.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [error]);

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
          senderName: form.sender_name ?? "",
          fromConnectionId: form.from_connection_id ?? "",
          bookingMeetingTypeId: form.booking_meeting_type_id ?? ""
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
    setRowError(null);
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
        setRowError({ id: prospectId, message: json.error?.message ?? t("actionFailed") });
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
      setRowError({ id: prospectId, message: t("actionFailed") });
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
   * Send the waiting drafts now, batch by batch, up to today's cap.
   *
   * The loop ends on the server's own answer: no allowance left, or nothing
   * left to send. A batch that sends zero also ends it, so a prospect the
   * server declines for its own reasons cannot spin this forever.
   */
  const sendAllDrafts = async () => {
    if (sendAllRunningRef.current) return;
    sendAllRunningRef.current = true;
    setSendAll({ sent: 0 });
    setError(null);
    setNotice(null);
    let sent = 0;
    try {
      for (;;) {
        const res = await fetch("/api/dashboard/outreach/send-all", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ businessId })
        });
        const json = (await res.json()) as {
          ok: boolean;
          data?: { sent: number; remaining: number; allowanceLeft: number };
          error?: { message?: string };
        };
        if (!json.ok || !json.data) {
          setError(json.error?.message ?? t("actionFailed"));
          return;
        }
        sent += json.data.sent;
        setSendAll({ sent });
        // Three ways to stop, and they are three different things to say. The
        // queue emptying is the happy one. The cap is the expected one. A batch
        // that sent nothing while allowance remained is neither: something
        // refused those drafts, and reporting it as "today's limit" would tell
        // the owner a limit was reached that was not.
        const { sent: justSent, remaining, allowanceLeft } = json.data;
        if (remaining <= 0) {
          setNotice(t("sentAll", { count: sent }));
          break;
        }
        if (allowanceLeft <= 0) {
          setNotice(t("sentAllCapped", { count: sent, left: remaining }));
          break;
        }
        if (justSent === 0) {
          setNotice(t("sentAllStalled", { count: sent, left: remaining }));
          break;
        }
      }
    } catch {
      setError(t("actionFailed"));
    } finally {
      // Re-read on every exit: the queue below is showing drafts that just
      // went out, and Send stays live over them until this lands.
      setDrafts({});
      await refresh();
      setSendAll(null);
      sendAllRunningRef.current = false;
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
  /** Real mailboxes, excluding the leading "Automatic" entry (id ""). */
  const connectedMailboxCount = (view?.mailboxes ?? []).filter((m) => m.id !== "").length;
  /**
   * Whether naming a meeting can change the link. More than one enabled
   * meeting, or exactly one that is hidden (the page would show an empty
   * chooser rather than that meeting).
   */
  const meetingChoiceMatters =
    (view?.meetings.length ?? 0) > 1 ||
    ((view?.meetings.length ?? 0) === 1 && Boolean(view?.meetings[0]?.hidden));
  /**
   * A named meeting that is no longer on offer. Exactly the mailbox trap one
   * field down: gating the control on "is there a choice worth making" strands
   * the stale id, the form keeps submitting it, the save is refused, and
   * nothing on the page can change it.
   */
  const pinnedMeetingGone = Boolean(
    form.booking_meeting_type_id &&
      !(view?.meetings ?? []).some((m) => m.id === form.booking_meeting_type_id)
  );
  /** A pin whose mailbox is gone: the one case that must show the picker anyway. */
  /**
   * How many more may go out today, computed SERVER-side by the same
   * arithmetic the send path uses. Deliberately not re-derived here: a number
   * on the button that disagrees with the number the server honours is the
   * failure this panel has already shipped twice.
   */
  const sendAllowanceLeft = view?.sendAllowanceLeft ?? 0;
  /**
   * What one press would actually send: the smaller of today's allowance and
   * the drafts waiting. The confirm, the help line, and the disabled state all
   * read this, because three places deriving "how many" separately is how the
   * help line came to promise the full allowance over a shorter queue.
   */
  const sendableNow = Math.max(0, Math.min(sendAllowanceLeft, view?.funnel.pending ?? 0));
  /**
   * Unsaved rewrites block Send all for the same reason they block the Send
   * beside each row: the server sends the STORED text, so the owner would watch
   * their rewrite go out as the old copy, and the refresh afterwards would then
   * drop the edit they never got to save.
   */
  const unsavedDrafts = Object.keys(drafts).length > 0;
  /** A pin whose mailbox is gone: the one case that must show the picker anyway. */
  const pinnedMailboxGone = Boolean(
    form.from_connection_id && !(view?.mailboxes ?? []).some((m) => m.id === form.from_connection_id)
  );

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
        <p
          ref={errorRef}
          role="alert"
          className="rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
        >
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
          {/* The sign-off is not the sender. Said here because the two fields
              sit together and reading one as the other is the obvious mistake. */}
          <p className="mt-1 text-xs text-parchment/50">{t("senderNameHelp")}</p>
        </div>
        {/* Which meeting the CTA links to. The page's own chooser asks "what
            would you like to book?", which is a fair question for someone who
            arrived on purpose and a bad one for a stranger who has read one
            paragraph.

            Shown when naming a meeting could produce a different link than
            not naming one. With one VISIBLE meeting the page already is that
            meeting, so there is nothing to choose. With one HIDDEN meeting
            there is: hidden keeps a type off the page's menu, so the page is
            the empty chooser and only a direct link reaches the meeting at
            all, which is precisely what hidden types are for. */}
        {view && (meetingChoiceMatters || pinnedMeetingGone) ? (
          <div>
            <label className={labelClass} htmlFor="prospecting-meeting">
              {t("fields.bookingMeeting")}
            </label>
            <select
              id="prospecting-meeting"
              className={inputClass}
              value={form.booking_meeting_type_id ?? ""}
              onChange={(e) => edit({ booking_meeting_type_id: e.target.value })}
            >
              {/* The stale pick gets a real option, so the control shows what
                  is actually stored. Without it the browser would display
                  "Let them choose" while state still held the dead id, and an
                  owner who thought they had cleared it would submit it again. */}
              {pinnedMeetingGone ? (
                <option value={form.booking_meeting_type_id ?? ""}>
                  {t("bookingMeetingGoneOption")}
                </option>
              ) : null}
              <option value="">{t("bookingMeetingChooser")}</option>
              {view.meetings.map((m) => (
                <option key={m.id} value={m.id}>
                  {t("bookingMeetingOption", { name: m.name, minutes: m.durationMinutes })}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-parchment/50">{t("bookingMeetingHelp")}</p>
          </div>
        ) : null}
        {/* Only worth a control when there is a real choice: one connected
            mailbox needs no picker, and none is a blocker rather than a
            preference. Counted on the CONNECTED entries, not the list length:
            the list leads with "Automatic" (id ""), so a single mailbox makes
            it two long and a length test shows a picker whose only decision is
            between automatic and the one mailbox automatic would have picked.

            The second arm is the escape hatch. A pin whose mailbox has since
            been disconnected refuses every save (the form keeps submitting the
            stale id) while the send path refuses to fall back to an address the
            owner did not choose. Hiding the control on mailbox count alone
            would leave outreach stopped with nothing on the page able to clear
            it. */}
        {view && (connectedMailboxCount > 1 || pinnedMailboxGone) ? (
          <div>
            <label className={labelClass} htmlFor="prospecting-from">
              {t("fields.fromMailbox")}
            </label>
            <select
              id="prospecting-from"
              className={inputClass}
              value={form.from_connection_id ?? ""}
              onChange={(e) => edit({ from_connection_id: e.target.value })}
            >
              {/* The stale pin gets a real option, so the control shows what is
                  actually stored. Without it the browser would display the
                  first option while state still held the disconnected id, and
                  an owner who "saw Automatic" would submit the stale pin again. */}
              {pinnedMailboxGone ? (
                <option value={form.from_connection_id ?? ""}>{t("fromMailboxGoneOption")}</option>
              ) : null}
              {view.mailboxes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-parchment/50">{t("fromMailboxHelp")}</p>
          </div>
        ) : null}
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
                    {v.open > 0 ? ` · ${t("verticalOpen", { count: v.open })}` : ""}
                  </span>
                  {/* Two presses, like the bulk rewrite: this retires work in
                      bulk, and the count makes the size of it plain. */}
                  {v.open === 0 ? (
                    // Nothing left to call off: this trade only has history now.
                    // A live button here offers to skip nothing, which is how it
                    // came to say "skips 0 waiting drafts".
                    <span className="text-xs text-parchment/40">{t("verticalNothingOpen")}</span>
                  ) : confirmVertical === v.vertical ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-amber-200">
                        {t("skipVerticalConfirm", { vertical: v.vertical, count: v.open })}
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
                      disabled={skippingVertical !== null || bulkRunning || sendAllRunning}
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
                  disabled={bulkRunning || sendAllRunning}
                  onClick={() => setBulk("confirm")}
                >
                  {t("actions.rewriteAll")}
                </Button>
              </div>
            )}
          </div>
          <p className="mt-1 text-xs text-parchment/50">{t("rewriteAllHelp")}</p>
          {/* Send all. The cap is named in the confirm rather than enforced
              silently: "all" cannot mean all when the daily limit is what
              protects the sending domain, and a button that quietly ignored it
              would be doing the owner harm on request. */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {sendAll === "confirm" ? (
              <>
                <span className="text-xs text-amber-200">
                  {t("sendAllConfirm", { count: sendableNow, waiting: view.funnel.pending })}
                </span>
                <Button onClick={() => void sendAllDrafts()}>{t("actions.sendAllYes")}</Button>
                <Button variant="secondary" onClick={() => setSendAll(null)}>
                  {t("actions.cancel")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  disabled={bulkRunning || sendAllRunning || unsavedDrafts || sendableNow === 0}
                  onClick={() => setSendAll("confirm")}
                >
                  {t("actions.sendAll")}
                </Button>
                {sendAllRunning ? (
                  <span className="text-xs text-parchment/60">
                    {t("sendAllProgress", { sent: sendAll.sent })}
                  </span>
                ) : (
                  <span className="text-xs text-parchment/50">
                    {unsavedDrafts
                      ? t("sendAllUnsaved")
                      : sendAllowanceLeft <= 0
                        ? t("sendAllCapSpent")
                        : t("sendAllHelp", { count: sendableNow })}
                  </span>
                )}
              </>
            )}
          </div>
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
                      disabled={busyId === item.id || bulkRunning || sendAllRunning}
                      onClick={() => void act(item.id, "skip")}
                    >
                      {t("actions.skip")}
                    </Button>
                    {/* Send is blocked while an edit is unsaved: the server
                        would send the stored draft, and the owner would watch
                        their rewrite go out as the old text.

                        Blocked on a spent cap too, for consistency with Send
                        all above it. The server refuses either way, so leaving
                        this one live only bought a click that always failed,
                        and two controls for the same action disagreeing about
                        whether it is available reads as a bug in whichever one
                        the owner tried second. The reason travels with it. */}
                    <Button
                      title={sendAllowanceLeft <= 0 ? t("capSpentTitle") : undefined}
                      disabled={
                        busyId === item.id ||
                        bulkRunning ||
                        sendAllRunning ||
                        sendAllowanceLeft <= 0 ||
                        Boolean(drafts[item.id])
                      }
                      onClick={() => void act(item.id, "send")}
                    >
                      {t("actions.send")}
                    </Button>
                  </div>
                </div>
                {/* The reason this row's press failed, on this row. Rendered
                    whether or not the draft is expanded, since Send and Skip
                    are pressed from the collapsed card. */}
                {rowError?.id === item.id ? (
                  <p
                    role="alert"
                    className="mt-2 rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
                  >
                    {rowError.message}
                  </p>
                ) : null}
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
                          disabled={busyId === item.id || bulkRunning || sendAllRunning || !drafts[item.id]}
                          onClick={() => void act(item.id, "edit")}
                        >
                          {t("actions.saveDraft")}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        disabled={busyId === item.id || bulkRunning || sendAllRunning}
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
