/**
 * Fire ONE real owner alert through the real dispatcher, to prove the push leg
 * end to end.
 *
 * This is not a simulation. `dispatchUrgentNotification` fans out to every
 * channel the business has enabled, so running this sends a genuine SMS and a
 * genuine email alongside the push, and writes real `notifications` rows. Only
 * ever point it at a business you own.
 *
 * Prints the per-channel outcome so the push row can be read next to the
 * others: which channels sent, which skipped and why, and how many devices
 * the push reached.
 *
 * Usage: tsx debug/push-live-alert.ts <businessId> [kind]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const businessId = process.argv[2];
if (!businessId) {
  console.error("Usage: tsx debug/push-live-alert.ts <businessId> [kind]");
  process.exit(1);
}
// Defaults to a kind notificationLink resolves to a real destination, so the
// tap target can be inspected rather than assumed.
const kind = process.argv[3] ?? "voice_capture";

const { dispatchUrgentNotification } = await import("../src/lib/notifications/dispatch.ts");
const { notificationLink } = await import("../src/lib/notifications/display.ts");

const payload = { source: "debug/push-live-alert" };

console.log(`business : ${businessId}`);
console.log(`kind     : ${kind}`);
console.log(`tap target notificationLink resolves to: ${notificationLink({ kind, payload }).href}`);
console.log("");

const result = await dispatchUrgentNotification({
  businessId,
  kind,
  summary: "Live push test from the dispatcher",
  payload
});

for (const r of result.results) {
  const reason = r.reason ? `  (${r.reason})` : "";
  console.log(`${r.status.padEnd(8)} ${r.channel.padEnd(12)}${reason}`);
}

const push = result.results.find((r) => r.channel === "push");
console.log("");
console.log(push ? `push row: ${push.status}, id ${push.notificationId}` : "push: NO ROW WRITTEN");
