import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedBusiness, serviceDb } from "./harness";
import { businessDefaultPhoneCountry } from "../../supabase/functions/_shared/business_country";

/**
 * The Mexican SMS cap, against REAL Postgres (mx_sms_cap migration):
 *
 * 1. business_phone_country (SQL) must agree with
 *    businessDefaultPhoneCountry (TS) across the fixture matrix, the SQL
 *    copy exists because try_reserve_sms_outbound_slot classifies inside
 *    the row lock, and a silent drift between the two would let the shown
 *    allowance and the enforced one disagree.
 * 2. try_reserve_sms_outbound_slot must clamp a Mexican STANDARD tenant to
 *    100/month (the tier cap alone would allow 3,000) while a US standard
 *    tenant sails past 100, and an enterprise Mexican tenant is exempt.
 */

const PHONES = [
  null,
  "",
  "+525512345678",
  "+52 1 55 1234 5678",
  "52 55 1234 5678",
  "5215512345678",
  "+52123",
  "+52 05 1234 5678",
  "5255123456",
  "(416) 456-0696",
  "+16028053377",
  "6025550100",
  "+447911123456",
  "12345"
];
const TIMEZONES = [null, "", "America/Mexico_City", "America/Tijuana", "America/Toronto", "America/Phoenix"];

describe("mx sms cap (SQL)", () => {
  let db: SupabaseClient;

  beforeAll(() => {
    db = serviceDb();
  });

  it("business_phone_country agrees with the TS mirror across the fixture matrix", async () => {
    for (const phone of PHONES) {
      for (const timezone of TIMEZONES) {
        const { data, error } = await db.rpc("business_phone_country", {
          p_phone: phone,
          p_timezone: timezone
        });
        expect(error).toBeNull();
        const ts = businessDefaultPhoneCountry({ phone, timezone });
        expect(
          { phone, timezone, sql: data },
          `phone=${JSON.stringify(phone)} tz=${JSON.stringify(timezone)}`
        ).toEqual({ phone, timezone, sql: ts });
      }
    }
  });

  async function usedThisMonth(dbc: SupabaseClient, businessId: string): Promise<number> {
    const monthStart = new Date();
    const start = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    const { data } = await dbc
      .from("daily_usage")
      .select("sms_text_units")
      .eq("business_id", businessId)
      .gte("usage_date", start);
    return (data ?? []).reduce(
      (n, r) => n + Number((r as { sms_text_units: number }).sms_text_units ?? 0),
      0
    );
  }

  // The cap is enforced against sms_text_units (weighted_sms_metering
  // migration); seed both columns like the backfill does (1 unit/message).
  async function seedUsage(dbc: SupabaseClient, businessId: string, smsSent: number) {
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await dbc.from("daily_usage").upsert(
      {
        business_id: businessId,
        usage_date: today,
        voice_minutes_used: 0,
        sms_sent: smsSent,
        sms_text_units: smsSent,
        calls_made: 0,
        peak_concurrent_calls: 0,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id,usage_date" }
    );
    expect(error).toBeNull();
  }

  it("clamps a Mexican standard tenant to 100/month while a US one passes", async () => {
    const mxId = await seedBusiness(db, "MX Cap Tenant");
    await db
      .from("businesses")
      .update({ tier: "standard", phone: "+525512345678", timezone: "America/Mexico_City" })
      .eq("id", mxId);
    await seedUsage(db, mxId, 100);

    const { data: refused, error: e1 } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: mxId
    });
    expect(e1).toBeNull();
    expect(refused).toMatchObject({ ok: false, reason: "monthly_sms_limit" });
    expect(await usedThisMonth(db, mxId)).toBe(100);

    const usId = await seedBusiness(db, "US Cap Tenant");
    await db
      .from("businesses")
      .update({ tier: "standard", phone: "+16025550100", timezone: "America/Phoenix" })
      .eq("id", usId);
    await seedUsage(db, usId, 100);

    const { data: allowed, error: e2 } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: usId
    });
    expect(e2).toBeNull();
    expect(allowed).toMatchObject({ ok: true, source: "plan" });
    expect(await usedThisMonth(db, usId)).toBe(101);
  });

  it("reserves normally for a Mexican tenant under the clamp", async () => {
    const mxId = await seedBusiness(db, "MX Under Cap Tenant");
    await db
      .from("businesses")
      .update({ tier: "standard", phone: "+525512345678", timezone: "America/Mexico_City" })
      .eq("id", mxId);
    await seedUsage(db, mxId, 42);

    const { data, error } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: mxId
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: true, source: "plan" });
    expect(await usedThisMonth(db, mxId)).toBe(43);
  });

  it("exempts enterprise Mexican tenants from the clamp", async () => {
    const entId = await seedBusiness(db, "MX Enterprise Tenant");
    await db
      .from("businesses")
      .update({ tier: "enterprise", phone: "+525512345678", timezone: "America/Mexico_City" })
      .eq("id", entId);
    await seedUsage(db, entId, 100);

    const { data, error } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: entId
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: true, source: "plan" });
  });
});
