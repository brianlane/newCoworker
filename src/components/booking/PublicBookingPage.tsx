"use client";

/**
 * Client half of the public booking page: two-panel layout (business
 * details left; month calendar, then time list, then confirm form right).
 * Slots come from POST /api/book/slots as raw ISO starts; all grouping and
 * rendering happens in the visitor's selected timezone, so the server
 * never needs to know it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

export type PublicBookingStrings = {
  eventTitle: string;
  durationMinutes: string;
  videoCallNote: string;
  selectDateTime: string;
  timezoneLabel: string;
  noSlotsThisMonth: string;
  loadingSlots: string;
  slotsUnavailable: string;
  backToCalendar: string;
  confirmHeading: string;
  nameLabel: string;
  phoneLabel: string;
  emailLabel: string;
  noteLabel: string;
  submitButton: string;
  submitting: string;
  slotTaken: string;
  submitFailed: string;
  checkDetails: string;
  bookedHeading: string;
  bookedBody: string;
  bookedVideoNote: string;
  poweredBy: string;
  weekdaysShort: string[];
};

type Props = {
  token: string;
  businessName: string;
  description: string | null;
  allowedDurations: number[];
  videoCall: boolean;
  strings: PublicBookingStrings;
};

type Slot = { startIso: string; endIso: string };

type BookedState = { startLocal: string | null; startIso: string; zoomJoinUrl: string | null };

/** "YYYY-MM-DD" of an instant in a timezone. */
function isoDateInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(iso));
}

function timeLabelInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(
    new Date(Date.UTC(year, month, 15))
  );
}

function fullDayLabel(isoDate: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

export function PublicBookingPage({
  token,
  businessName,
  description,
  allowedDurations,
  videoCall,
  strings
}: Props) {
  const browserZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    []
  );
  const zoneChoices = useMemo(() => {
    const all =
      typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    return all.includes(browserZone) || all.length === 0 ? all : [browserZone, ...all];
  }, [browserZone]);

  const [timezone, setTimezone] = useState(browserZone);
  const [duration, setDuration] = useState(allowedDurations[0]);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slotsError, setSlotsError] = useState(false);
  const [monthCursor, setMonthCursor] = useState<{ year: number; month: number } | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", note: "" });
  const [submitState, setSubmitState] = useState<
    "idle" | "submitting" | "slot_taken" | "invalid" | "failed"
  >("idle");
  const [booked, setBooked] = useState<BookedState | null>(null);

  const loadSlots = useCallback(async () => {
    setSlots(null);
    setSlotsError(false);
    try {
      const res = await fetch("/api/book/slots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, durationMinutes: duration })
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error("slots failed");
      setSlots(body.data.slots as Slot[]);
    } catch {
      setSlotsError(true);
    }
  }, [token, duration]);

  useEffect(() => {
    void loadSlots();
  }, [loadSlots]);

  const slotsByDay = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const slot of slots ?? []) {
      const day = isoDateInZone(slot.startIso, timezone);
      const list = map.get(day) ?? [];
      list.push(slot);
      map.set(day, list);
    }
    return map;
  }, [slots, timezone]);

  const firstBookableDay = useMemo(() => {
    const days = [...slotsByDay.keys()].sort();
    return days[0] ?? null;
  }, [slotsByDay]);

  const cursor = useMemo(() => {
    if (monthCursor) return monthCursor;
    const anchor = firstBookableDay ?? isoDateInZone(new Date().toISOString(), timezone);
    return { year: Number(anchor.slice(0, 4)), month: Number(anchor.slice(5, 7)) - 1 };
  }, [monthCursor, firstBookableDay, timezone]);

  const calendarCells = useMemo(() => {
    const first = new Date(Date.UTC(cursor.year, cursor.month, 1));
    const startPad = first.getUTCDay();
    const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month + 1, 0)).getUTCDate();
    const cells: Array<{ isoDate: string; day: number } | null> = [];
    for (let i = 0; i < startPad; i += 1) cells.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) {
      const iso = `${cursor.year}-${String(cursor.month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      cells.push({ isoDate: iso, day: d });
    }
    return cells;
  }, [cursor]);

  const monthHasSlots = useMemo(
    () =>
      [...slotsByDay.keys()].some((day) => {
        return (
          Number(day.slice(0, 4)) === cursor.year && Number(day.slice(5, 7)) - 1 === cursor.month
        );
      }),
    [slotsByDay, cursor]
  );

  const submit = useCallback(async () => {
    if (!selectedSlot) return;
    setSubmitState("submitting");
    try {
      const res = await fetch("/api/book/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          startIso: selectedSlot.startIso,
          durationMinutes: duration,
          name: form.name,
          phone: form.phone,
          email: form.email,
          ...(form.note.trim() ? { note: form.note } : {})
        })
      });
      const body = await res.json();
      if (res.status === 409) {
        setSubmitState("slot_taken");
        setSelectedSlot(null);
        void loadSlots();
        return;
      }
      if (!res.ok || !body.ok) {
        setSubmitState(body?.error?.code === "VALIDATION_ERROR" ? "invalid" : "failed");
        return;
      }
      setBooked({
        startLocal: body.data.startLocal ?? null,
        startIso: body.data.startIso,
        zoomJoinUrl: body.data.zoomJoinUrl ?? null
      });
    } catch {
      setSubmitState("failed");
    }
  }, [selectedSlot, token, duration, form, loadSlots]);

  const panel = "rounded-lg border border-parchment/10 bg-parchment/5";
  const label = "block text-xs uppercase tracking-wider text-parchment/40";
  const input =
    "mt-1 w-full rounded-md border border-parchment/20 bg-deep-ink px-3 py-2 text-sm " +
    "text-parchment placeholder:text-parchment/30 focus:border-claw-green focus:outline-none";

  if (booked) {
    const localLine =
      booked.startLocal ??
      `${fullDayLabel(isoDateInZone(booked.startIso, timezone), timezone)}, ${timeLabelInZone(booked.startIso, timezone)}`;
    return (
      <div className={`${panel} mx-auto max-w-xl p-8 text-center`}>
        <h1 className="text-2xl font-bold text-claw-green">{strings.bookedHeading}</h1>
        <p className="mt-3 text-sm text-parchment/80">{strings.bookedBody}</p>
        <p className="mt-4 rounded-md border border-claw-green/40 bg-claw-green/10 px-4 py-3 text-sm text-claw-green">
          {localLine}
        </p>
        {booked.zoomJoinUrl ? (
          <p className="mt-3 text-sm text-parchment/60">{strings.bookedVideoNote}</p>
        ) : null}
        <p className="mt-8 text-xs text-parchment/30">{strings.poweredBy}</p>
      </div>
    );
  }

  return (
    <div className={`${panel} grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]`}>
      {/* Left panel: business + event details */}
      <div className="border-b border-parchment/10 p-6 md:border-b-0 md:border-r">
        <p className="text-xs uppercase tracking-wider text-parchment/40">{businessName}</p>
        <h1 className="mt-2 text-xl font-bold text-parchment">{strings.eventTitle}</h1>
        <div className="mt-4 space-y-2 text-sm text-parchment/60">
          {allowedDurations.length > 1 ? (
            <div className="flex flex-wrap gap-2">
              {allowedDurations.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => {
                    setDuration(d);
                    setSelectedDay(null);
                    setSelectedSlot(null);
                    setSubmitState("idle");
                  }}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    d === duration
                      ? "border-claw-green bg-claw-green/10 text-claw-green"
                      : "border-parchment/20 text-parchment/60 hover:border-parchment/40"
                  }`}
                >
                  {d} {strings.durationMinutes}
                </button>
              ))}
            </div>
          ) : (
            <p>
              {duration} {strings.durationMinutes}
            </p>
          )}
          {videoCall ? <p>{strings.videoCallNote}</p> : null}
          {description ? (
            <p className="pt-2 leading-relaxed text-parchment/70">{description}</p>
          ) : null}
        </div>
        <p className="mt-8 hidden text-xs text-parchment/30 md:block">{strings.poweredBy}</p>
      </div>

      {/* Right panel: calendar → times → confirm */}
      <div className="p-6">
        {selectedSlot ? (
          <div>
            <button
              type="button"
              onClick={() => {
                setSelectedSlot(null);
                setSubmitState("idle");
              }}
              className="text-xs text-parchment/50 hover:text-parchment"
            >
              ← {strings.backToCalendar}
            </button>
            <h2 className="mt-3 text-lg font-semibold text-parchment">
              {strings.confirmHeading}
            </h2>
            <p className="mt-1 text-sm text-claw-green">
              {fullDayLabel(isoDateInZone(selectedSlot.startIso, timezone), timezone)},{" "}
              {timeLabelInZone(selectedSlot.startIso, timezone)}
            </p>
            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <div>
                <label className={label} htmlFor="bk-name">
                  {strings.nameLabel}
                </label>
                <input
                  id="bk-name"
                  required
                  maxLength={200}
                  className={input}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div>
                <label className={label} htmlFor="bk-phone">
                  {strings.phoneLabel}
                </label>
                <input
                  id="bk-phone"
                  required
                  type="tel"
                  maxLength={40}
                  className={input}
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </div>
              <div>
                <label className={label} htmlFor="bk-email">
                  {strings.emailLabel}
                </label>
                <input
                  id="bk-email"
                  required
                  type="email"
                  maxLength={320}
                  className={input}
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div>
                <label className={label} htmlFor="bk-note">
                  {strings.noteLabel}
                </label>
                <textarea
                  id="bk-note"
                  maxLength={1000}
                  rows={3}
                  className={input}
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                />
              </div>
              {submitState === "slot_taken" ? (
                <p className="text-sm text-amber-400">{strings.slotTaken}</p>
              ) : null}
              {submitState === "invalid" ? (
                <p className="text-sm text-amber-400">{strings.checkDetails}</p>
              ) : null}
              {submitState === "failed" ? (
                <p className="text-sm text-red-400">{strings.submitFailed}</p>
              ) : null}
              <button
                type="submit"
                disabled={submitState === "submitting"}
                className="w-full rounded-md bg-claw-green px-4 py-2 text-sm font-semibold text-deep-ink hover:opacity-90 disabled:opacity-50"
              >
                {submitState === "submitting" ? strings.submitting : strings.submitButton}
              </button>
            </form>
          </div>
        ) : (
          <div>
            <h2 className="text-lg font-semibold text-parchment">{strings.selectDateTime}</h2>
            {slotsError ? (
              <p className="mt-4 text-sm text-red-400">{strings.slotsUnavailable}</p>
            ) : slots === null ? (
              <p className="mt-4 text-sm text-parchment/50">{strings.loadingSlots}</p>
            ) : (
              <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <div>
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      aria-label="previous month"
                      onClick={() =>
                        setMonthCursor({
                          year: cursor.month === 0 ? cursor.year - 1 : cursor.year,
                          month: cursor.month === 0 ? 11 : cursor.month - 1
                        })
                      }
                      className="px-2 text-parchment/50 hover:text-parchment"
                    >
                      ‹
                    </button>
                    <p className="text-sm font-medium text-parchment">
                      {monthLabel(cursor.year, cursor.month)}
                    </p>
                    <button
                      type="button"
                      aria-label="next month"
                      onClick={() =>
                        setMonthCursor({
                          year: cursor.month === 11 ? cursor.year + 1 : cursor.year,
                          month: cursor.month === 11 ? 0 : cursor.month + 1
                        })
                      }
                      className="px-2 text-parchment/50 hover:text-parchment"
                    >
                      ›
                    </button>
                  </div>
                  <div className="mt-3 grid grid-cols-7 gap-1 text-center">
                    {strings.weekdaysShort.map((d) => (
                      <p key={d} className="text-[10px] uppercase text-parchment/40">
                        {d}
                      </p>
                    ))}
                    {calendarCells.map((cell, i) =>
                      cell === null ? (
                        <span key={`pad-${i}`} />
                      ) : slotsByDay.has(cell.isoDate) ? (
                        <button
                          key={cell.isoDate}
                          type="button"
                          onClick={() => setSelectedDay(cell.isoDate)}
                          className={`rounded-full py-1.5 text-sm ${
                            selectedDay === cell.isoDate
                              ? "bg-claw-green font-semibold text-deep-ink"
                              : "bg-claw-green/10 text-claw-green hover:bg-claw-green/20"
                          }`}
                        >
                          {cell.day}
                        </button>
                      ) : (
                        <span key={cell.isoDate} className="py-1.5 text-sm text-parchment/25">
                          {cell.day}
                        </span>
                      )
                    )}
                  </div>
                  {!monthHasSlots ? (
                    <p className="mt-3 text-xs text-parchment/40">{strings.noSlotsThisMonth}</p>
                  ) : null}
                  <div className="mt-5">
                    <label className={label} htmlFor="bk-tz">
                      {strings.timezoneLabel}
                    </label>
                    {zoneChoices.length > 0 ? (
                      <select
                        id="bk-tz"
                        className={input}
                        value={timezone}
                        onChange={(e) => {
                          setTimezone(e.target.value);
                          setSelectedDay(null);
                        }}
                      >
                        {zoneChoices.map((z) => (
                          <option key={z} value={z}>
                            {z.replaceAll("_", " ")}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="mt-1 text-sm text-parchment/60">{timezone}</p>
                    )}
                  </div>
                </div>
                <div>
                  {selectedDay ? (
                    <div>
                      <p className="text-sm font-medium text-parchment">
                        {fullDayLabel(selectedDay, timezone)}
                      </p>
                      <div className="mt-3 flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
                        {(slotsByDay.get(selectedDay) ?? []).map((slot) => (
                          <button
                            key={slot.startIso}
                            type="button"
                            onClick={() => {
                              setSelectedSlot(slot);
                              setSubmitState("idle");
                            }}
                            className="rounded-md border border-claw-green/40 px-3 py-2 text-sm text-claw-green hover:bg-claw-green/10"
                          >
                            {timeLabelInZone(slot.startIso, timezone)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
