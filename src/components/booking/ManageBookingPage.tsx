"use client";

/**
 * Invitee view of one booking: what they hold, and the two things they can
 * do about it. Deliberately plain next to the booking page's two-panel
 * layout, because someone landing here has one job (move it or drop it)
 * and usually arrives from an email on a phone.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

type Slot = { startIso: string };

type Strings = {
  heading: string;
  withBusiness: string;
  durationMinutes: string;
  joinLabel: string;
  rescheduleButton: string;
  cancelButton: string;
  cancelConfirm: string;
  keepButton: string;
  pickNewTime: string;
  loadingSlots: string;
  noSlots: string;
  tooLate: string;
  needsHuman: string;
  past: string;
  slotsUnavailable: string;
  canceledHeading: string;
  canceledBody: string;
  canceledBookAgain: string;
  movedHeading: string;
  slotTaken: string;
  changeFailed: string;
  backButton: string;
  poweredBy: string;
};

type Props = {
  token: string;
  businessName: string;
  timezone: string;
  startIso: string;
  durationMinutes: number;
  zoomJoinUrl: string | null;
  changeable: boolean;
  past: boolean;
  /** Public booking page URL for the rebook link after cancel; null = plain text. */
  bookingPageUrl: string | null;
  strings: Strings;
};

type View = "summary" | "picking" | "confirmCancel" | "canceled" | "moved";

export function ManageBookingPage({
  token,
  timezone,
  startIso,
  durationMinutes,
  zoomJoinUrl,
  changeable,
  past,
  bookingPageUrl,
  strings
}: Props) {
  const [view, setView] = useState<View>("summary");
  const [start, setStart] = useState(startIso);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  // Distinct from an empty list: a failed load must not read as "no times".
  const [slotsFailed, setSlotsFailed] = useState(false);
  const [slotsTimezone, setSlotsTimezone] = useState(timezone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rendered in the BUSINESS's zone, matching the confirmation the invitee
  // already has: showing two different times for one appointment is how
  // people miss calls.
  const formatted = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: timezone,
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short"
      }).format(new Date(start));
    } catch {
      return start;
    }
  }, [start, timezone]);

  const formatSlot = useCallback(
    (iso: string) => {
      try {
        return new Intl.DateTimeFormat(undefined, {
          timeZone: slotsTimezone,
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit"
        }).format(new Date(iso));
      } catch {
        return iso;
      }
    },
    [slotsTimezone]
  );

  useEffect(() => {
    if (view !== "picking" || slots !== null) return;
    let active = true;
    void (async () => {
      try {
        const res = await fetch(`/api/book/manage/slots?token=${encodeURIComponent(token)}`);
        const body = await res.json();
        if (!active) return;
        if (!res.ok || !body.ok) {
          setSlotsFailed(true);
          setSlots([]);
          return;
        }
        setSlotsTimezone(body.data.timezone ?? timezone);
        setSlots(body.data.slots ?? []);
      } catch {
        if (active) {
          setSlotsFailed(true);
          setSlots([]);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [view, slots, token, timezone]);

  const act = useCallback(
    async (action: "cancel" | "reschedule", startChoice?: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/book/manage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, action, startIso: startChoice })
        });
        const body = await res.json();
        if (!res.ok || !body.ok) {
          // 409 = someone took that time, 422 = inside the business's
          // minimum-notice window. Both have their own copy; a generic
          // failure would leave the visitor guessing.
          setError(
            res.status === 409
              ? strings.slotTaken
              : res.status === 422
                ? strings.tooLate
                : res.status === 423
                  ? strings.needsHuman
                  : res.status === 410
                    ? strings.past
                    : strings.changeFailed
          );
          // A raced slot means the offer is stale: re-fetch rather than
          // leave the visitor clicking a time that is gone.
          if (res.status === 409) {
            setSlotsFailed(false);
            setSlots(null);
          }
          return;
        }
        if (action === "cancel") {
          setView("canceled");
          return;
        }
        if (startChoice) setStart(body.data?.startIso ?? startChoice);
        // The old list is stale the moment the appointment moves: it was
        // built around the previous time (and excluded it). Dropping it
        // makes re-entering the picker refetch.
        setSlotsFailed(false);
        setSlots(null);
        setView("moved");
      } catch {
        setError(strings.changeFailed);
      } finally {
        setBusy(false);
      }
    },
    [
      strings.changeFailed,
      strings.needsHuman,
      strings.past,
      strings.slotTaken,
      strings.tooLate,
      token
    ]
  );

  const card = "rounded-2xl border border-parchment/15 bg-ink-800/60 p-6";

  if (view === "canceled") {
    return (
      <div className={card}>
        <h1 className="text-xl font-semibold text-parchment">{strings.canceledHeading}</h1>
        <p className="mt-2 text-sm text-parchment/70">
          {strings.canceledBody}{" "}
          {bookingPageUrl ? (
            <a href={bookingPageUrl} className="text-signal-teal hover:underline">
              {strings.canceledBookAgain}
            </a>
          ) : (
            strings.canceledBookAgain
          )}
        </p>
        <p className="mt-6 text-xs text-parchment/35">{strings.poweredBy}</p>
      </div>
    );
  }

  return (
    <div className={card}>
      <h1 className="text-xl font-semibold text-parchment">
        {view === "moved" ? strings.movedHeading : strings.heading}
      </h1>
      <p className="mt-1 text-sm text-parchment/60">{strings.withBusiness}</p>

      <div className="mt-4 rounded-xl border border-parchment/15 bg-deep-ink px-4 py-3">
        <p className="text-base text-parchment">{formatted}</p>
        <p className="mt-1 text-xs text-parchment/50">
          {durationMinutes} {strings.durationMinutes}
        </p>
        {zoomJoinUrl ? (
          <a
            href={zoomJoinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block rounded-lg bg-claw-green px-3 py-1.5 text-xs font-semibold text-deep-ink"
          >
            {strings.joinLabel}
          </a>
        ) : null}
      </div>

      {error ? <p className="mt-4 text-sm text-red-400">{error}</p> : null}

      {!changeable ? (
        <p className="mt-4 text-sm text-parchment/60">
          {past ? strings.past : strings.tooLate}
        </p>
      ) : view === "summary" || view === "moved" ? (
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              // Always refetch on entry: availability moves while this page
              // sits open, and a cached list can offer times that are gone.
              setSlotsFailed(false);
              setSlots(null);
              setView("picking");
            }}
            className="rounded-lg border border-claw-green/50 px-4 py-2 text-sm text-claw-green hover:bg-claw-green/10 disabled:opacity-50"
          >
            {strings.rescheduleButton}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              setView("confirmCancel");
            }}
            className="rounded-lg border border-parchment/20 px-4 py-2 text-sm text-parchment/60 hover:border-parchment/40 disabled:opacity-50"
          >
            {strings.cancelButton}
          </button>
        </div>
      ) : view === "confirmCancel" ? (
        <div className="mt-5">
          <p className="text-sm text-parchment/80">{strings.cancelConfirm}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void act("cancel")}
              className="rounded-lg bg-red-500/90 px-4 py-2 text-sm font-semibold text-deep-ink hover:bg-red-500 disabled:opacity-50"
            >
              {strings.cancelButton}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setView("summary")}
              className="rounded-lg border border-parchment/20 px-4 py-2 text-sm text-parchment/60 hover:border-parchment/40 disabled:opacity-50"
            >
              {strings.keepButton}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-5">
          <p className="text-sm text-parchment/80">{strings.pickNewTime}</p>
          {slots === null ? (
            <p className="mt-3 text-sm text-parchment/50">{strings.loadingSlots}</p>
          ) : slotsFailed ? (
            <p className="mt-3 text-sm text-red-400">{strings.slotsUnavailable}</p>
          ) : slots.length === 0 ? (
            <p className="mt-3 text-sm text-parchment/50">{strings.noSlots}</p>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {slots.map((s) => (
                <button
                  key={s.startIso}
                  type="button"
                  disabled={busy}
                  onClick={() => void act("reschedule", s.startIso)}
                  className="rounded-lg border border-parchment/20 px-3 py-2 text-sm text-parchment hover:border-claw-green/60 disabled:opacity-50"
                >
                  {formatSlot(s.startIso)}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => setView("summary")}
            className="mt-4 text-xs text-parchment/50 underline hover:text-parchment/70"
          >
            {strings.backButton}
          </button>
        </div>
      )}

      <p className="mt-6 text-xs text-parchment/35">{strings.poweredBy}</p>
    </div>
  );
}
