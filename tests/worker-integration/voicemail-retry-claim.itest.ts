import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBusiness, serviceDb } from "./harness";

/**
 * The cancelled_amd retry claim, against the local stack.
 *
 * A mocked query builder cannot prove the WHERE clause: two in-flight
 * speak.ended handlers both seeing `voicemail_speak_restarted` unset is
 * exactly the race the compare-and-set exists to close. The first claim
 * (`voice_claim_voicemail_speak`) cannot gate the retry because the retry
 * already holds it.
 */
describe("voice_claim_voicemail_retry (compare-and-set)", () => {
  const db = serviceDb();
  let businessId = "";
  const ids = {
    claimed: `v3:itest-retry-${randomUUID()}`,
    unclaimed: `v3:itest-retry-none-${randomUUID()}`,
    race: `v3:itest-retry-race-${randomUUID()}`
  };

  beforeAll(async () => {
    businessId = await seedBusiness(db, "Voicemail retry claim itest");
    const rows = [
      {
        call_control_id: ids.claimed,
        business_id: businessId,
        from_e164: "+16025550100",
        chain_from_e164: "+16025550100",
        status: "ai_intake",
        context: { voicemail_claimed: true }
      },
      {
        call_control_id: ids.unclaimed,
        business_id: businessId,
        from_e164: "+16025550101",
        chain_from_e164: "+16025550101",
        status: "ai_intake",
        context: {}
      },
      {
        call_control_id: ids.race,
        business_id: businessId,
        from_e164: "+16025550102",
        chain_from_e164: "+16025550102",
        status: "ai_intake",
        context: { voicemail_claimed: true }
      }
    ];
    const { error } = await db.from("voice_handoff_sessions").insert(rows);
    if (error) throw new Error(`seed sessions: ${error.message}`);
  });

  afterAll(async () => {
    await db.from("voice_handoff_sessions").delete().in("call_control_id", Object.values(ids));
    await db.from("businesses").delete().eq("id", businessId);
  });

  it("flips restarted once, and refuses a second caller", async () => {
    const first = await db.rpc("voice_claim_voicemail_retry", {
      p_call_control_id: ids.claimed
    });
    if (first.error) throw new Error(first.error.message);
    expect(first.data).toBe(true);

    const second = await db.rpc("voice_claim_voicemail_retry", {
      p_call_control_id: ids.claimed
    });
    if (second.error) throw new Error(second.error.message);
    expect(second.data).toBe(false);

    const { data } = await db
      .from("voice_handoff_sessions")
      .select("context")
      .eq("call_control_id", ids.claimed)
      .single();
    expect((data as { context: Record<string, unknown> }).context.voicemail_speak_restarted).toBe(
      true
    );
  });

  it("does not grant a retry on a leg that never claimed the first speak", async () => {
    const { data, error } = await db.rpc("voice_claim_voicemail_retry", {
      p_call_control_id: ids.unclaimed
    });
    if (error) throw new Error(error.message);
    expect(data).toBe(false);
  });

  it("lets only one of two concurrent callers win", async () => {
    const [a, b] = await Promise.all([
      db.rpc("voice_claim_voicemail_retry", { p_call_control_id: ids.race }),
      db.rpc("voice_claim_voicemail_retry", { p_call_control_id: ids.race })
    ]);
    if (a.error) throw new Error(a.error.message);
    if (b.error) throw new Error(b.error.message);
    const wins = [a.data, b.data].filter((v) => v === true).length;
    expect(wins).toBe(1);
    expect([a.data, b.data].filter((v) => v === false).length).toBe(1);
  });
});
