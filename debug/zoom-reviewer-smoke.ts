/**
 * Live smoke test for the Zoom Review Sandbox business: verifies the
 * reviewer test plan's booking steps work end-to-end on the connected
 * Google calendar (book → reschedule → cancel), leaving nothing behind.
 * Zoom decoration is exercised only when a Zoom connection exists (the
 * reviewer connects their own in step 2 of the plan).
 *
 * Usage: tsx debug/zoom-reviewer-smoke.ts
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const BIZ = "e2b7a1c4-0000-4000-8000-000000000001"; // Zoom Review Sandbox

const { resolveCalendarConnection } = await import("../src/lib/voice-tools/connections.ts");
const { bookCalendarAppointment } = await import("../src/lib/calendar-tools/handlers.ts");
const { rescheduleCalendarAppointment, cancelCalendarAppointment } =
  await import("../src/lib/calendar-tools/reschedule.ts");

const conn = await resolveCalendarConnection(BIZ);
console.log("resolved connection:", conn);
if (!conn) throw new Error("no calendar connection resolved");

// Tomorrow 18:00 UTC for 30 minutes.
const start = new Date(Date.now() + 24 * 3600 * 1000);
start.setUTCHours(18, 0, 0, 0);
const end = new Date(start.getTime() + 30 * 60 * 1000);

const booked = await bookCalendarAppointment(
  BIZ,
  {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    summary: "Smoke test — safe to ignore",
    attendeeName: "Smoke Test",
    attendeePhone: "+15550100000",
    notes: "Automated pre-review smoke test; will self-cancel."
  },
  "+15550100000"
);
console.log("book result:", JSON.stringify(booked, null, 2));
if (!booked.ok) throw new Error("booking failed");

// Move the same event one hour later — the meeting-update leg of the
// reviewer test plan (provider sends an UPDATED invite, never a second one).
const newStart = new Date(start.getTime() + 60 * 60 * 1000);
const newEnd = new Date(end.getTime() + 60 * 60 * 1000);
const moved = await rescheduleCalendarAppointment(
  BIZ,
  {
    newStartIso: newStart.toISOString(),
    newEndIso: newEnd.toISOString(),
    attendeePhone: "+15550100000"
  },
  "+15550100000"
);
console.log("reschedule result:", JSON.stringify(moved, null, 2));
if (!moved.ok) throw new Error("reschedule failed — clean up the event manually");

const canceled = await cancelCalendarAppointment(
  BIZ,
  { attendeePhone: "+15550100000" },
  "+15550100000"
);
console.log("cancel result:", JSON.stringify(canceled, null, 2));
if (!canceled.ok) throw new Error("cancel failed — clean up the event manually");

console.log("SMOKE OK: book + reschedule + cancel round-trip succeeded on", conn.provider);
