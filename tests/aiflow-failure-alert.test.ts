import { describe, expect, it, vi } from "vitest";
import {
  AIFLOW_FAILURE_TASK_TYPE,
  describeLead,
  sendAiflowFailureAlert
} from "../supabase/functions/_shared/aiflow_failure_alert";

/**
 * Opt-in AiFlow failure alerts: a dead-lettered lead-intake run notifies the
 * owner ONLY when `notification_preferences.aiflow_failure_alerts` is true
 * (default false). The gate fails closed, test/simulated runs never alert,
 * and a delivered page for the same run is never repeated.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const RUN = "10000000-0000-0000-0000-000000000001";
const FLOW = "20000000-0000-0000-0000-000000000001";
const NOTIFY_URL = "https://example.supabase.co/functions/v1/notifications";

const baseInput = (fetchFn: typeof fetch, over: Record<string, unknown> = {}) => ({
  businessId: BIZ,
  runId: RUN,
  flowId: FLOW,
  trigger: { channel: "tenant_email" } as Record<string, unknown>,
  vars: { lead_name: "Dwight Colclough", lead_phone: "+14168775223" } as Record<string, unknown>,
  error: "upsert_customer: the lead's phone is missing or unusable",
  notifyUrl: NOTIFY_URL,
  bearer: "service-key",
  fetchFn,
  ...over
});

/** Chainable fake client: one scripted result per terminal await. */
type Scripted = { data?: unknown; error?: unknown };
function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "limit", "maybeSingle"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

const okFetch = () =>
  vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

const OPTED_IN = { data: { aiflow_failure_alerts: true }, error: null };
const NO_PRIOR = { data: [], error: null };

describe("describeLead", () => {
  it("prefers name (phone), then falls back through the parts", () => {
    expect(describeLead({ lead_name: "Ada", lead_phone: "+15551234567" })).toBe(
      "Ada (+15551234567)"
    );
    expect(describeLead({ lead_name: "Ada" })).toBe("Ada");
    expect(describeLead({ lead_phone: "+15551234567" })).toBe("+15551234567");
    expect(describeLead({ lead_name: "  ", lead_phone: 42 })).toBe("an unidentified lead");
    expect(describeLead(null)).toBe("an unidentified lead");
  });

  it("falls back to booking-flow invitee vars and email contact (KYP Jul 22 alerts)", () => {
    // The failed booking-confirmation runs carried invitee_* vars only — the
    // alert must name the person, not say "an unidentified lead".
    expect(
      describeLead({
        invitee_name: "James Test Six",
        invitee_phone: "none",
        invitee_email: "james@example.com"
      })
    ).toBe("James Test Six (james@example.com)");
    expect(describeLead({ invitee_name: "James Test Six" })).toBe("James Test Six");
    expect(describeLead({ invitee_email: "james@example.com" })).toBe("james@example.com");
    // lead_* vars still win over invitee_*; phone still wins over email.
    expect(
      describeLead({
        lead_name: "Ada",
        invitee_name: "Bob",
        lead_phone: "+15551234567",
        invitee_email: "bob@example.com"
      })
    ).toBe("Ada (+15551234567)");
    // The extractor's literal "none"/"NONE" placeholders never surface.
    expect(describeLead({ lead_name: "NONE", invitee_phone: "none" })).toBe(
      "an unidentified lead"
    );
  });
});

describe("sendAiflowFailureAlert", () => {
  it("alerts an opted-in owner with the run-stamped payload", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([OPTED_IN, NO_PRIOR]);
    const result = await sendAiflowFailureAlert(db, baseInput(fetchFn));
    expect(result).toBe("sent");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ];
    expect(url).toBe(NOTIFY_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer service-key");
    const body = JSON.parse(String(init.body));
    expect(body.record.task_type).toBe(AIFLOW_FAILURE_TASK_TYPE);
    expect(body.record.status).toBe("urgent_alert");
    expect(body.record.business_id).toBe(BIZ);
    expect(body.record.log_payload.run_id).toBe(RUN);
    expect(body.record.log_payload.flow_id).toBe(FLOW);
    expect(body.record.log_payload.lead_label).toBe("Dwight Colclough (+14168775223)");
    expect(body.record.log_payload.reason).toContain("missing or unusable");
  });

  it("clips a long failure reason to 300 chars", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([OPTED_IN, NO_PRIOR]);
    await sendAiflowFailureAlert(db, baseInput(fetchFn, { error: "x".repeat(900) }));
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ];
    const body = JSON.parse(String(init.body));
    expect(body.record.log_payload.reason).toHaveLength(300);
  });

  it("webhook-channel runs are lead intake too", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([OPTED_IN, NO_PRIOR]);
    const result = await sendAiflowFailureAlert(
      db,
      baseInput(fetchFn, { trigger: { channel: "webhook" } })
    );
    expect(result).toBe("sent");
  });

  it("non-lead-intake channels never alert (no prefs read, no post)", async () => {
    const fetchFn = okFetch();
    const { db, calls } = makeDb([]);
    for (const trigger of [
      { channel: "contact_event" },
      { channel: "manual" },
      {},
      null,
      undefined
    ]) {
      const result = await sendAiflowFailureAlert(db, baseInput(fetchFn, { trigger }));
      expect(result).toBe("not_lead_intake");
    }
    expect(calls).toHaveLength(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("simulated test runs never alert (boolean or stringly-typed marker)", async () => {
    const fetchFn = okFetch();
    const { db, calls } = makeDb([]);
    for (const test_mode of [true, "true"]) {
      const result = await sendAiflowFailureAlert(
        db,
        baseInput(fetchFn, { trigger: { channel: "tenant_email", test_mode } })
      );
      expect(result).toBe("test_mode");
    }
    expect(calls).toHaveLength(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("defaults to silent: no prefs row / false toggle → opted_out", async () => {
    const fetchFn = okFetch();
    for (const prefs of [
      { data: null, error: null },
      { data: { aiflow_failure_alerts: false }, error: null }
    ]) {
      const { db } = makeDb([prefs]);
      const result = await sendAiflowFailureAlert(db, baseInput(fetchFn));
      expect(result).toBe("opted_out");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a prefs read error FAILS CLOSED (opted_out, no post)", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([{ data: null, error: { message: "boom" } }]);
    const result = await sendAiflowFailureAlert(db, baseInput(fetchFn));
    expect(result).toBe("opted_out");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a DELIVERED prior page for this run suppresses a repeat", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([OPTED_IN, { data: [{ id: "n1" }], error: null }]);
    const result = await sendAiflowFailureAlert(db, baseInput(fetchFn));
    expect(result).toBe("already_alerted");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a dedupe lookup error logs and still alerts (silence is the worse failure)", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([OPTED_IN, { data: null, error: { message: "boom" } }]);
    const result = await sendAiflowFailureAlert(db, baseInput(fetchFn));
    expect(result).toBe("sent");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a null dedupe result (no rows, no error) alerts", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([OPTED_IN, { data: null, error: null }]);
    const result = await sendAiflowFailureAlert(db, baseInput(fetchFn));
    expect(result).toBe("sent");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("defaults to the global fetch when no fetchFn is injected", async () => {
    const globalFetch = okFetch();
    vi.stubGlobal("fetch", globalFetch);
    try {
      const { db } = makeDb([OPTED_IN, NO_PRIOR]);
      const result = await sendAiflowFailureAlert(db, baseInput(undefined as never, { fetchFn: undefined }));
      expect(result).toBe("sent");
      expect(globalFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a non-2xx notify response reports post_failed", async () => {
    const fetchFn = vi.fn(
      async () => new Response("nope", { status: 500 })
    ) as unknown as typeof fetch;
    const { db } = makeDb([OPTED_IN, NO_PRIOR]);
    const result = await sendAiflowFailureAlert(db, baseInput(fetchFn));
    expect(result).toBe("post_failed");
  });

  it("a thrown fetch reports post_failed and never throws", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { db } = makeDb([OPTED_IN, NO_PRIOR]);
    const result = await sendAiflowFailureAlert(db, baseInput(fetchFn));
    expect(result).toBe("post_failed");
  });
});
