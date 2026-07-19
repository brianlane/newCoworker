import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { seedBusiness, serviceDb } from "./harness";

/**
 * The `sms_link_click` RPC against REAL Postgres — the decision core of the
 * Jul 18 KYP triple-notification incident (PR #753, fix 2): the owner got
 * three simultaneous "opened your booking link" alerts because carrier /
 * device link-preview PREFETCH hits (observed 3-16s after delivery) counted
 * as human first clicks.
 *
 * The fix lives in plpgsql (migration 20260814030000), which the unit layer
 * can only mock: clicks inside the 60s prefetch window are logged but
 * flagged `likely_prefetch` and never notify; `should_notify` is true for
 * exactly ONE click per link — the first non-prefetch one — because
 * `notified_at` is stamped in the same locked transaction that reports it.
 * This suite replays the incident's click pattern (a burst of delivery-time
 * prefetches, then a real tap, then more taps) and pins the alert count.
 *
 * Out of scope here (unit-tested in tests/link-click-notify.test.ts and
 * tests/link-preview-bots.test.ts): the /s/[code] route's bot-UA / HEAD
 * short-circuit and the per-contact hourly collapse in the Next notify
 * path — both sit in front of / behind this RPC.
 */

type ClickResult = {
  ok: boolean;
  url?: string;
  link_id?: string;
  click_count?: number;
  is_first_click?: boolean;
  is_prefetch?: boolean;
  should_notify?: boolean;
};

let db: SupabaseClient;

beforeAll(() => {
  db = serviceDb();
});

async function mintLink(
  businessId: string,
  over: Record<string, unknown> = {}
): Promise<{ id: string; code: string }> {
  const code = `it${randomUUID().slice(0, 10).replace(/-/g, "")}`;
  const { data, error } = await db
    .from("sms_links")
    .insert({
      business_id: businessId,
      short_code: code,
      original_url: "https://calendly.com/e2e/booking",
      to_e164: "+14165550190",
      source: "ai_flow",
      ...over
    })
    .select("id")
    .single();
  if (error) throw new Error(`mintLink: ${error.message}`);
  return { id: (data as { id: string }).id, code };
}

async function click(code: string): Promise<ClickResult> {
  const { data, error } = await db.rpc("sms_link_click", { p_short_code: code });
  if (error) throw new Error(`sms_link_click: ${error.message}`);
  return data as ClickResult;
}

/** Backdate the link so the next click falls OUTSIDE the prefetch window. */
async function ageLink(linkId: string, secondsAgo: number): Promise<void> {
  const { error } = await db
    .from("sms_links")
    .update({ created_at: new Date(Date.now() - secondsAgo * 1000).toISOString() })
    .eq("id", linkId);
  if (error) throw new Error(`ageLink: ${error.message}`);
}

async function linkRow(linkId: string): Promise<{
  click_count: number;
  first_clicked_at: string | null;
  notified_at: string | null;
}> {
  const { data, error } = await db
    .from("sms_links")
    .select("click_count, first_clicked_at, notified_at")
    .eq("id", linkId)
    .single();
  if (error) throw new Error(`linkRow: ${error.message}`);
  return data as { click_count: number; first_clicked_at: string | null; notified_at: string | null };
}

async function clickRows(linkId: string): Promise<Array<{ likely_prefetch: boolean }>> {
  const { data, error } = await db
    .from("sms_link_clicks")
    .select("likely_prefetch")
    .eq("link_id", linkId)
    .order("clicked_at");
  if (error) throw new Error(`clickRows: ${error.message}`);
  return data as Array<{ likely_prefetch: boolean }>;
}

describe("sms_link_click RPC (real Postgres) — the triple-notification incident pattern", () => {
  it("a delivery-time prefetch burst never notifies; the first human tap notifies exactly once", async () => {
    const biz = await seedBusiness(db, "IT link clicks incident");
    const link = await mintLink(biz);

    // The incident: three preview/scanner hits seconds after the SMS went
    // out. All land inside the 60s prefetch window — logged and counted,
    // flagged, and NONE may notify (pre-fix each was a "first click" race
    // candidate and the owner got three alerts).
    for (let i = 1; i <= 3; i++) {
      const res = await click(link.code);
      expect(res.ok).toBe(true);
      expect(res.url).toBe("https://calendly.com/e2e/booking");
      expect(res.is_prefetch).toBe(true);
      expect(res.should_notify).toBe(false);
      expect(res.click_count).toBe(i);
    }
    let row = await linkRow(link.id);
    expect(row.click_count).toBe(3);
    expect(row.first_clicked_at).not.toBeNull(); // honest raw data
    expect(row.notified_at).toBeNull(); // no alert consumed

    // The lead's REAL tap, minutes later: first non-prefetch click →
    // should_notify true, notified_at stamped atomically with the report.
    await ageLink(link.id, 300);
    const human = await click(link.code);
    expect(human.is_prefetch).toBe(false);
    expect(human.should_notify).toBe(true);
    expect(human.is_first_click).toBe(false); // prefetches already counted
    row = await linkRow(link.id);
    expect(row.notified_at).not.toBeNull();

    // Every later tap (re-opens, forwards) is one engagement already
    // alerted on — never a second notification from this link.
    for (let i = 0; i < 2; i++) {
      const again = await click(link.code);
      expect(again.is_prefetch).toBe(false);
      expect(again.should_notify).toBe(false);
    }

    // The event log keeps the truthful split: 3 flagged prefetches, 3 human.
    const events = await clickRows(link.id);
    expect(events.map((e) => e.likely_prefetch)).toEqual([true, true, true, false, false, false]);
  });

  it("a link whose FIRST click is human notifies on that click (no prefetch ever happened)", async () => {
    const biz = await seedBusiness(db, "IT link clicks human-first");
    const link = await mintLink(biz);
    await ageLink(link.id, 120);

    const res = await click(link.code);
    expect(res.ok).toBe(true);
    expect(res.is_first_click).toBe(true);
    expect(res.is_prefetch).toBe(false);
    expect(res.should_notify).toBe(true);
    expect((await linkRow(link.id)).notified_at).not.toBeNull();
  });

  it("a link that only ever gets prefetch hits still has its one alert available for a later tap", async () => {
    // The regression the notified_at design closes: under the old
    // "notify on the first click" rule, a suppressed prefetch first click
    // would have consumed the link's only alert — the real tap after it
    // would never notify. The stamp moves with the DECISION, not the click
    // ordinal.
    const biz = await seedBusiness(db, "IT link clicks prefetch-only");
    const link = await mintLink(biz);

    const prefetch = await click(link.code);
    expect(prefetch.is_prefetch).toBe(true);
    expect(prefetch.should_notify).toBe(false);
    expect((await linkRow(link.id)).notified_at).toBeNull();

    await ageLink(link.id, 90);
    const human = await click(link.code);
    expect(human.should_notify).toBe(true);
  });

  it("unknown and blank short codes resolve ok:false without side effects", async () => {
    expect((await click("itnope00000")).ok).toBe(false);
    expect((await click("  ")).ok).toBe(false);
  });

  it("a backdated notified_at is honored: an already-alerted link never re-alerts", async () => {
    // The migration's backfill stamps notified_at for links that alerted
    // under the old rule; the RPC must treat that stamp as final.
    const biz = await seedBusiness(db, "IT link clicks backfilled");
    const link = await mintLink(biz, {
      notified_at: new Date(Date.now() - 3600_000).toISOString()
    });
    await ageLink(link.id, 600);

    const res = await click(link.code);
    expect(res.ok).toBe(true);
    expect(res.is_prefetch).toBe(false);
    expect(res.should_notify).toBe(false);
  });
});
