import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedBusiness, serviceDb } from "./harness";
import {
  smsDestinationCountry as tsCountry
} from "../../supabase/functions/_shared/sms_destination_rates";

/**
 * The destination gate against REAL Postgres (sms_destination_gating
 * migration):
 *
 * 1. sms_destination_country (SQL) agrees with the TS mirror across a
 *    fixture matrix (three copies of the dial-code data: SQL table, src
 *    lib, edge lib; the unit tests pin src==edge, this pins SQL==edge).
 * 2. try_reserve refuses denylisted, unknown-prefix, and velocity-capped
 *    destinations; allows and records everything else; flags the first
 *    send to a new non-domestic country and writes the operator system_log.
 * 3. The sms_outbound_log trigger fills destination_country.
 */

const MATRIX = [
  "+16025550100",
  "+15145188192",
  "+18765550100",
  "+18095550100",
  "+85261234567",
  "+4520123456",
  "+447911123456",
  "+525512345678",
  "+79261234567",
  "+77012345678",
  "+8816214567890",
  "+9795551234",
  "6025550100",
  ""
];

describe("sms destination gating (SQL)", () => {
  let db: SupabaseClient;

  beforeAll(() => {
    db = serviceDb();
  });

  it("sms_destination_country agrees with the TS mirror across the matrix", async () => {
    for (const e164 of MATRIX) {
      const { data, error } = await db.rpc("sms_destination_country", { p_e164: e164 });
      expect(error).toBeNull();
      expect({ e164, sql: data }, `e164=${JSON.stringify(e164)}`).toEqual({
        e164,
        sql: tsCountry(e164)
      });
    }
  });

  async function makeTenant(name: string): Promise<string> {
    const id = await seedBusiness(db, name);
    await db
      .from("businesses")
      .update({ tier: "standard", phone: "+16025550100", timezone: "America/Phoenix" })
      .eq("id", id);
    return id;
  }

  it("refuses denylisted and unknown destinations, default-closed", async () => {
    const id = await makeTenant("Gate Denylist Tenant");
    const { data: cuba } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: id,
      p_text_units: 1,
      p_destination_e164: "+5355512345"
    });
    expect(cuba).toMatchObject({ ok: false, reason: "destination_blocked" });

    const { data: satellite } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: id,
      p_text_units: 1,
      p_destination_e164: "+8816214567890"
    });
    expect(satellite).toMatchObject({ ok: false, reason: "destination_unknown" });
  });

  it("flags the first send to a new country, writes the operator log, then stops flagging", async () => {
    const id = await makeTenant("Gate First Country Tenant");
    const { data: first, error } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: id,
      p_text_units: 1,
      p_destination_e164: "+85261234567"
    });
    expect(error).toBeNull();
    expect(first).toMatchObject({
      ok: true,
      destination_country: "HK",
      new_destination_country: true
    });

    const { data: logs } = await db
      .from("system_logs")
      .select("event, level, payload")
      .eq("business_id", id)
      .eq("event", "sms_first_send_to_country");
    expect(logs).toHaveLength(1);
    expect((logs?.[0] as { payload: { country: string } }).payload.country).toBe("HK");

    const { data: second } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: id,
      p_text_units: 1,
      p_destination_e164: "+85261234568"
    });
    expect(second).toMatchObject({ ok: true, new_destination_country: false });
  });

  it("applies the rolling-hour velocity brake per country, domestic exempt", async () => {
    const id = await makeTenant("Gate Velocity Tenant");
    for (let i = 0; i < 20; i += 1) {
      const { data } = await db.rpc("try_reserve_sms_outbound_slot", {
        p_business_id: id,
        p_text_units: 1,
        p_destination_e164: `+852${61231000 + i}`
      });
      expect(data).toMatchObject({ ok: true });
    }
    const { data: capped } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: id,
      p_text_units: 1,
      p_destination_e164: "+85261239999"
    });
    expect(capped).toMatchObject({ ok: false, reason: "destination_velocity" });

    // A different country is unaffected, and domestic has no brake at all.
    const { data: gb } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: id,
      p_text_units: 1,
      p_destination_e164: "+447911123456"
    });
    expect(gb).toMatchObject({ ok: true });
    const { data: us } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: id,
      p_text_units: 1,
      p_destination_e164: "+16025550101"
    });
    expect(us).toMatchObject({ ok: true });
  });

  it("a cap-refused reserve records no event and no first-country alert", async () => {
    // Bugbot: a normal plpgsql return commits earlier writes, so recording
    // before the cap check let refused sends inflate velocity and fire
    // false alerts. Events now write only on success.
    const id = await makeTenant("Gate Refused Tenant");
    const today = new Date().toISOString().slice(0, 10);
    await db.from("daily_usage").upsert(
      {
        business_id: id,
        usage_date: today,
        voice_minutes_used: 0,
        sms_sent: 5000,
        sms_text_units: 5000,
        calls_made: 0,
        peak_concurrent_calls: 0,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id,usage_date" }
    );
    const { data } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: id,
      p_text_units: 1,
      p_destination_e164: "+85261234567"
    });
    expect(data).toMatchObject({ ok: false, reason: "monthly_sms_limit" });
    const { data: events } = await db
      .from("sms_destination_events")
      .select("id")
      .eq("business_id", id);
    expect(events).toHaveLength(0);
    const { data: logs } = await db
      .from("system_logs")
      .select("id")
      .eq("business_id", id)
      .eq("event", "sms_first_send_to_country");
    expect(logs).toHaveLength(0);
  });

  it("null destination keeps legacy callers ungated", async () => {
    const id = await makeTenant("Gate Legacy Tenant");
    const { data } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: id,
      p_text_units: 1
    });
    expect(data).toMatchObject({ ok: true });
  });

  it("the outbound-log trigger fills destination_country", async () => {
    const id = await makeTenant("Gate Log Tenant");
    const { error } = await db.from("sms_outbound_log").insert({
      business_id: id,
      to_e164: "+85261234567",
      from_e164: "+16025550100",
      body: "hello",
      source: "ai_flow"
    });
    expect(error).toBeNull();
    const { data } = await db
      .from("sms_outbound_log")
      .select("destination_country")
      .eq("business_id", id)
      .single();
    expect((data as { destination_country: string }).destination_country).toBe("HK");
  });
});
