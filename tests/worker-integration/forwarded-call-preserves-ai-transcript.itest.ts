import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordForwardedCall } from "../../supabase/functions/_shared/forwarded_call_log";
import { seedBusiness, serviceDb } from "./harness";

/**
 * The forwarded-call record, run against a REAL Postgres and a REAL PostgREST
 * client rather than a hand-built mock.
 *
 * The unit tests prove which call shapes the module makes. They cannot prove
 * the thing that actually bit us, because the damage was done by PostgREST
 * semantics: `upsert(onConflict)` REPLACES the conflicting row, so columns
 * absent from the payload revert to their defaults. That is invisible against a
 * mock, which just records the arguments it was handed. The bug survived a
 * fully green unit suite for a month (Amy Laidlaw, calls 24c3a49c on 2026-07-14
 * and 5634b7f0 on 2026-08-18).
 *
 * So this seeds a genuine AI transcript, complete with turns, runs the real
 * warm-transfer record against it, and reads the row back out of the database.
 */
describe("a warm transfer does not destroy the AI transcript it belongs to", () => {
  const db = serviceDb();
  let businessId = "";
  const callControlId = `v3:itest-${randomUUID()}`;
  const startedAt = "2026-08-18T18:46:03.799Z";

  beforeAll(async () => {
    businessId = await seedBusiness(db, "Forwarded transcript itest");
    const { data, error } = await db
      .from("voice_call_transcripts")
      .insert({
        business_id: businessId,
        call_control_id: callControlId,
        caller_e164: "+14348413119",
        // An OUTBOUND call the platform placed itself, with a real model. Both
        // facts were being overwritten.
        model: "gemini-3.1-flash-live-preview",
        direction: "outbound",
        status: "in_progress",
        started_at: startedAt
      })
      .select("id")
      .single();
    if (error) throw new Error(`seed transcript: ${error.message}`);
    const transcriptId = (data as { id: string }).id;
    const turns = [
      { role: "caller", content: "What is your offer?", turn_index: 0 },
      { role: "assistant", content: "One moment while I get Dave Lane on the line.", turn_index: 1 }
    ];
    const { error: turnErr } = await db
      .from("voice_call_transcript_turns")
      .insert(turns.map((t) => ({ ...t, transcript_id: transcriptId })));
    if (turnErr) throw new Error(`seed turns: ${turnErr.message}`);
  });

  afterAll(async () => {
    await db.from("voice_call_transcripts").delete().eq("call_control_id", callControlId);
    await db.from("businesses").delete().eq("id", businessId);
  });

  it("keeps the direction, the model, and the unsummarized state", async () => {
    const res = await recordForwardedCall(db as never, {
      businessId,
      callControlId,
      outcome: "answered",
      callerE164: "+14348413119",
      forwardedToE164: "+16025245719",
      startedAtIso: startedAt
    });
    expect(res).toEqual({ status: "recorded" });

    const { data } = await db
      .from("voice_call_transcripts")
      .select("direction, model, call_kind, status, summary, summarized_at, forwarded_to_e164, started_at, ended_at")
      .eq("call_control_id", callControlId)
      .single();
    const row = data as Record<string, unknown>;

    // The three fields the overwrite was destroying.
    expect(row.direction).toBe("outbound");
    expect(row.model).toBe("gemini-3.1-flash-live-preview");
    // Null summarized_at is what keeps this call in the summary sweep's queue.
    // Stamping it is why two production calls with real transcripts will never
    // have an AI summary until the backfill runs.
    expect(row.summarized_at).toBeNull();

    // The forwarded facts still land.
    expect(row.call_kind).toBe("forwarded");
    expect(row.forwarded_to_e164).toBe("+16025245719");
    expect(row.status).toBe("completed");
    expect(row.started_at).toBe("2026-08-18T18:46:03.799+00:00");
    expect(row.ended_at).not.toBeNull();
  });

  it("leaves every transcript turn in place", async () => {
    // The turns hang off the transcript by FK. A row REPLACE keeps the same id
    // so they survive today, but nothing pinned that, and an upsert that ever
    // deleted and reinserted would silently take the whole conversation with
    // it.
    const { data: t } = await db
      .from("voice_call_transcripts")
      .select("id")
      .eq("call_control_id", callControlId)
      .single();
    const { data: turns } = await db
      .from("voice_call_transcript_turns")
      .select("role, content")
      .eq("transcript_id", (t as { id: string }).id)
      .order("turn_index", { ascending: true });
    expect(turns).toHaveLength(2);
    expect((turns as { content: string }[])[0].content).toBe("What is your offer?");
  });

  it("still creates a row for a call the AI never handled", async () => {
    // The module's original job, unchanged: a call the routing layer forwards
    // straight to a human has no bridge row, and must still appear in history.
    const plainCall = `v3:itest-${randomUUID()}`;
    const res = await recordForwardedCall(db as never, {
      businessId,
      callControlId: plainCall,
      outcome: "answered",
      callerE164: "+14805551212",
      forwardedToE164: "+16025245719"
    });
    expect(res).toEqual({ status: "recorded" });
    const { data } = await db
      .from("voice_call_transcripts")
      .select("model, direction, call_kind, status, summarized_at")
      .eq("call_control_id", plainCall)
      .single();
    expect(data).toMatchObject({
      model: "forwarded",
      direction: "inbound",
      call_kind: "forwarded",
      status: "completed"
    });
    // A row with no turns has nothing to summarize, so it stays terminal.
    expect((data as { summarized_at: string | null }).summarized_at).not.toBeNull();
    await db.from("voice_call_transcripts").delete().eq("call_control_id", plainCall);
  });

  it("does not downgrade the AI row when the transfer rang out", async () => {
    const res = await recordForwardedCall(db as never, {
      businessId,
      callControlId,
      outcome: "missed",
      callerE164: "+14348413119",
      forwardedToE164: "+16025245719"
    });
    expect(res).toEqual({ status: "superseded" });
    const { data } = await db
      .from("voice_call_transcripts")
      .select("status, model")
      .eq("call_control_id", callControlId)
      .single();
    expect(data).toMatchObject({ status: "completed", model: "gemini-3.1-flash-live-preview" });
  });
});
