/**
 * opaque-time-off-mirrors.ts, re-mark existing time-off mirror events BUSY.
 *
 * Background (Aug 19 2026, founder report): the shared-calendar time-off
 * mirror wrote its all-day "out of office" events transparent (Google) /
 * showAs free (Microsoft) as "display-only", so provider free/busy never
 * carried them and the booking page, find-slots, and waitlist fill kept
 * offering days the roster had marked off. mirrorTimeOffEvent now writes
 * Busy (transparency "opaque" / showAs "oof"); this script re-marks the
 * mirrors that already exist, so time off entered BEFORE the fix blocks
 * availability the same way.
 *
 * Scope: every employee_time_off row holding a calendar_event_id whose
 * range has not already ended (patching a past mirror changes nothing a
 * visitor can book; pass --all to sweep those too). Idempotent: re-marking
 * an already-opaque event is a no-op PATCH.
 *
 * A row whose event PATCH fails (deleted by hand on the calendar, revoked
 * connection) is logged and skipped; the script exits non-zero so a partial
 * sweep never reads as done.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/opaque-time-off-mirrors.ts            # dry-run
 *   npx tsx scripts/oneshot/opaque-time-off-mirrors.ts --apply    # write
 *   (optional) --business <uuid>   limit to one tenant
 *   (optional) --all               include ranges that already ended
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../../debug/_shared.ts";
import { getSharedCalendar } from "@/lib/calendar-tools/shared-calendar";
import { workspaceProxyForBusiness } from "@/lib/workspace/proxy";
import { recordOneshotApplied } from "./_ledger";

loadEnv();

const APPLY = process.argv.includes("--apply");
const INCLUDE_PAST = process.argv.includes("--all");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const ONLY_BUSINESS = argValue("--business");

type TimeOffRow = {
  id: string;
  business_id: string;
  starts_on: string;
  ends_on: string;
  calendar_event_id: string;
};

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error("[oneshot] missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const todayIso = new Date().toISOString().slice(0, 10);
  let query = db
    .from("employee_time_off")
    .select("id,business_id,starts_on,ends_on,calendar_event_id")
    .not("calendar_event_id", "is", null)
    // Explicit and generous: PostgREST silently clamps unlimited selects to
    // 1000 rows, and a clamped sweep would read as complete.
    .limit(5000);
  if (!INCLUDE_PAST) query = query.gte("ends_on", todayIso);
  if (ONLY_BUSINESS) query = query.eq("business_id", ONLY_BUSINESS);
  const { data, error } = await query;
  if (error) {
    console.error(`[oneshot] employee_time_off read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as TimeOffRow[];
  if (rows.length === 5000) {
    console.error("[oneshot] hit the 5000-row guard; narrow with --business and re-run");
    process.exit(1);
  }
  console.log(
    `[oneshot] ${rows.length} mirrored time-off row(s) ${INCLUDE_PAST ? "(past included)" : `ending on/after ${todayIso}`}${APPLY ? "" : " [dry-run]"}`
  );

  const byBusiness = new Map<string, TimeOffRow[]>();
  for (const row of rows) {
    const list = byBusiness.get(row.business_id) ?? [];
    list.push(row);
    byBusiness.set(row.business_id, list);
  }

  let patched = 0;
  let failed = 0;
  for (const [businessId, businessRows] of byBusiness) {
    const shared = await getSharedCalendar(businessId);
    if (!shared) {
      // The mirror only ever wrote onto an existing shared calendar, so a
      // missing one now means the connection is gone; nothing to patch.
      console.log(`  ${businessId}: no shared calendar resolved, skipping ${businessRows.length} row(s)`);
      failed += businessRows.length;
      continue;
    }
    const { calendarId, conn } = shared;
    const patchedIds: string[] = [];
    for (const row of businessRows) {
      const label = `${businessId} ${row.starts_on}..${row.ends_on} event ${row.calendar_event_id}`;
      if (!APPLY) {
        console.log(`  would mark busy: ${label} (${conn.provider})`);
        patched += 1;
        continue;
      }
      try {
        const target = {
          connectionId: conn.connectionId,
          providerConfigKey: conn.providerConfigKey
        };
        if (conn.provider === "google") {
          await workspaceProxyForBusiness(businessId, target, {
            endpoint: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(row.calendar_event_id)}`,
            method: "PATCH",
            data: { transparency: "opaque" }
          });
        } else {
          await workspaceProxyForBusiness(businessId, target, {
            endpoint: `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(row.calendar_event_id)}`,
            method: "PATCH",
            data: { showAs: "oof" }
          });
        }
        console.log(`  marked busy: ${label}`);
        patched += 1;
        patchedIds.push(row.calendar_event_id);
      } catch (err) {
        console.error(
          `  FAILED: ${label}: ${err instanceof Error ? err.message : String(err)}`
        );
        failed += 1;
      }
    }
    if (APPLY && patchedIds.length > 0) {
      await recordOneshotApplied(db, {
        scriptPath: process.argv[1] ?? "opaque-time-off-mirrors.ts",
        businessId,
        details: { patchedEventIds: patchedIds }
      });
    }
  }

  console.log(`[oneshot] ${APPLY ? "patched" : "would patch"} ${patched}, failed ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`[oneshot] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
