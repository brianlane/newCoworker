import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedBusiness, serviceDb } from "./harness";

/**
 * Weighted SMS metering against REAL Postgres (weighted_sms_metering
 * migration): the monthly cap is enforced on `daily_usage.sms_text_units`
 * (one unit per SMS part, 2.2 per MMS) while `sms_sent` keeps counting
 * messages for analytics. Covers:
 *
 * 1. A multi-part reserve charges its units atomically (+1 message, +N units)
 *    and the matching release refunds exactly what was charged.
 * 2. The default arg keeps legacy 1-arg callers metering one unit.
 * 3. The cap refuses on UNITS, not messages: a tenant whose 150-unit starter
 *    budget is spent by 50 long messages is refused on message 51.
 * 4. Fractional MMS units (2.2) survive the numeric column round-trip.
 * 5. Bonus spill past the cap consumes round(units) purchased texts, and the
 *    bonus-refund release restores them.
 */

describe("weighted sms metering (SQL)", () => {
  let db: SupabaseClient;

  beforeAll(() => {
    db = serviceDb();
  });

  async function totals(
    dbc: SupabaseClient,
    businessId: string
  ): Promise<{ sms_sent: number; sms_text_units: number }> {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    const { data } = await dbc
      .from("daily_usage")
      .select("sms_sent, sms_text_units")
      .eq("business_id", businessId)
      .gte("usage_date", start);
    let sent = 0;
    let units = 0;
    for (const r of (data ?? []) as Array<{ sms_sent: number; sms_text_units: number }>) {
      sent += Number(r.sms_sent ?? 0);
      units += Number(r.sms_text_units ?? 0);
    }
    return { sms_sent: sent, sms_text_units: units };
  }

  async function makeStarter(name: string): Promise<string> {
    const id = await seedBusiness(db, name);
    await db
      .from("businesses")
      .update({ tier: "starter", phone: "+16025550100", timezone: "America/Phoenix" })
      .eq("id", id);
    return id;
  }

  it("charges N units + 1 message per reserve, and release refunds the same", async () => {
    const id = await makeStarter("Weighted Reserve Tenant");

    const { data: r1, error: e1 } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: id,
      p_text_units: 9
    });
    expect(e1).toBeNull();
    expect(r1).toMatchObject({ ok: true, source: "plan" });
    expect(await totals(db, id)).toEqual({ sms_sent: 1, sms_text_units: 9 });

    const { error: relErr } = await db.rpc("release_sms_outbound_slot", {
      p_business_id: id,
      p_refund_bonus: false,
      p_text_units: 9
    });
    expect(relErr).toBeNull();
    expect(await totals(db, id)).toEqual({ sms_sent: 0, sms_text_units: 0 });
  });

  it("legacy 1-arg callers still meter one unit through the default", async () => {
    const id = await makeStarter("Weighted Default Tenant");
    const { data, error } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: id
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: true });
    expect(await totals(db, id)).toEqual({ sms_sent: 1, sms_text_units: 1 });
  });

  it("refuses on units, not messages: 50 ten-part messages exhaust starter's 150", async () => {
    const id = await makeStarter("Weighted Cap Tenant");
    // Seed 15 ten-part messages: only 15 messages, but 150 units = the full
    // starter cap. Under the old message meter this tenant had 85 sends left.
    const today = new Date().toISOString().slice(0, 10);
    const { error: seedErr } = await db.from("daily_usage").upsert(
      {
        business_id: id,
        usage_date: today,
        voice_minutes_used: 0,
        sms_sent: 15,
        sms_text_units: 150,
        calls_made: 0,
        peak_concurrent_calls: 0,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id,usage_date" }
    );
    expect(seedErr).toBeNull();

    const { data, error } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: id,
      p_text_units: 1
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: false, reason: "monthly_sms_limit" });
    expect(await totals(db, id)).toEqual({ sms_sent: 15, sms_text_units: 150 });
  });

  it("keeps fractional MMS units exact through the numeric column", async () => {
    const id = await makeStarter("Weighted MMS Tenant");
    for (let i = 0; i < 2; i += 1) {
      const { data, error } = await db.rpc("try_reserve_sms_outbound_slot", {
        p_business_id: id,
        p_text_units: 2.2
      });
      expect(error).toBeNull();
      expect(data).toMatchObject({ ok: true });
    }
    expect(await totals(db, id)).toEqual({ sms_sent: 2, sms_text_units: 4.4 });
  });

  it("spills round(units) into bonus texts past the cap, and refunds them on release", async () => {
    const id = await makeStarter("Weighted Bonus Tenant");
    const today = new Date().toISOString().slice(0, 10);
    await db.from("daily_usage").upsert(
      {
        business_id: id,
        usage_date: today,
        voice_minutes_used: 0,
        sms_sent: 150,
        sms_text_units: 150,
        calls_made: 0,
        peak_concurrent_calls: 0,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id,usage_date" }
    );
    const { error: grantErr } = await db.from("sms_bonus_grants").insert({
      business_id: id,
      stripe_checkout_session_id: `test_${id}`,
      texts_purchased: 100,
      texts_remaining: 100,
      purchased_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
    });
    expect(grantErr).toBeNull();

    const { data, error } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: id,
      p_text_units: 3
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: true, source: "bonus" });
    const { data: g1 } = await db
      .from("sms_bonus_grants")
      .select("texts_remaining")
      .eq("business_id", id)
      .single();
    expect((g1 as { texts_remaining: number }).texts_remaining).toBe(97);

    const { error: relErr } = await db.rpc("release_sms_outbound_slot", {
      p_business_id: id,
      p_refund_bonus: true,
      p_text_units: 3
    });
    expect(relErr).toBeNull();
    const { data: g2 } = await db
      .from("sms_bonus_grants")
      .select("texts_remaining")
      .eq("business_id", id)
      .single();
    expect((g2 as { texts_remaining: number }).texts_remaining).toBe(100);
  });
});
