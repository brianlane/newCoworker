import { describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_REPLY_COALESCE_MINUTES,
  CUSTOMER_REPLY_TASK_TYPE,
  sendCustomerReplyAlert
} from "../supabase/functions/_shared/customer_reply_alert";

/**
 * Opt-in "client replied" owner alerts (KYP, Jul 20 2026): deterministic
 * pipeline notification when a customer inbound lands, gated on
 * `notification_preferences.customer_reply_alerts` (default false, FAILS
 * CLOSED), skipped on retry claims and forward_owner contacts (the owner
 * already receives those texts verbatim), and coalesced per contact so a
 * multi-part text pages once.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+17808039935";
const NOTIFY_URL = "https://example.supabase.co/functions/v1/notifications";

const baseInput = (fetchFn: typeof fetch, over: Record<string, unknown> = {}) => ({
  businessId: BIZ,
  contactE164: LEAD,
  inboundPreview: "HI - will have to rebook as mentioned",
  attempt: 1,
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
    for (const m of ["select", "eq", "or", "gte", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["maybeSingle"] = (...args: unknown[]) => {
      calls.push({ table, name: "maybeSingle", args });
      return Promise.resolve(next());
    };
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

const okFetch = () =>
  vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

const OPTED_IN = { data: { customer_reply_alerts: true }, error: null };
const NAMED_CONTACT = {
  data: { display_name: "Tim Tsai", sms_reply_mode: "auto" },
  error: null
};
const NO_PRIOR = { data: [], error: null };

describe("sendCustomerReplyAlert", () => {
  it("pages the owner with the contact-stamped payload", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([OPTED_IN, NAMED_CONTACT, NO_PRIOR]);
    const result = await sendCustomerReplyAlert(db, baseInput(fetchFn));
    expect(result).toBe("sent");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ];
    expect(url).toBe(NOTIFY_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer service-key");
    const body = JSON.parse(String(init.body));
    expect(body.record.task_type).toBe(CUSTOMER_REPLY_TASK_TYPE);
    expect(body.record.status).toBe("urgent_alert");
    expect(body.record.business_id).toBe(BIZ);
    expect(body.record.log_payload.contact_e164).toBe(LEAD);
    expect(body.record.log_payload.contact_label).toBe("Tim Tsai");
    expect(body.record.log_payload.inbound_preview).toBe(
      "HI - will have to rebook as mentioned"
    );
  });

  it("labels by number when no contact row exists, and tolerates a contact read error", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([OPTED_IN, { data: null, error: null }, NO_PRIOR]);
    expect(await sendCustomerReplyAlert(db, baseInput(fetchFn))).toBe("sent");
    let body = JSON.parse(
      String(((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body)
    );
    expect(body.record.log_payload.contact_label).toBe(LEAD);

    // A contact read error still alerts — silence is the worse failure.
    const fetchFn2 = okFetch();
    const { db: db2 } = makeDb([OPTED_IN, { data: null, error: { message: "boom" } }, NO_PRIOR]);
    expect(await sendCustomerReplyAlert(db2, baseInput(fetchFn2))).toBe("sent");
    body = JSON.parse(
      String(((fetchFn2 as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body)
    );
    expect(body.record.log_payload.contact_label).toBe(LEAD);
  });

  it("clips a long inbound preview to 200 chars", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([OPTED_IN, NAMED_CONTACT, NO_PRIOR]);
    await sendCustomerReplyAlert(db, baseInput(fetchFn, { inboundPreview: "y".repeat(900) }));
    const body = JSON.parse(
      String(((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body)
    );
    expect(body.record.log_payload.inbound_preview).toHaveLength(200);
  });

  it("retry claims never re-page (attempt > 1, no reads, no post)", async () => {
    const fetchFn = okFetch();
    const { db, calls } = makeDb([]);
    const result = await sendCustomerReplyAlert(db, baseInput(fetchFn, { attempt: 2 }));
    expect(result).toBe("retry_attempt");
    expect(calls).toHaveLength(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("defaults to silent: no prefs row / false toggle → opted_out", async () => {
    const fetchFn = okFetch();
    for (const prefs of [
      { data: null, error: null },
      { data: { customer_reply_alerts: false }, error: null }
    ]) {
      const { db } = makeDb([prefs]);
      expect(await sendCustomerReplyAlert(db, baseInput(fetchFn))).toBe("opted_out");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a prefs read error FAILS CLOSED (opted_out, no post)", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([{ data: null, error: { message: "boom" } }]);
    expect(await sendCustomerReplyAlert(db, baseInput(fetchFn))).toBe("opted_out");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("forward_owner contacts never alert — the owner already receives those texts verbatim", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([
      OPTED_IN,
      { data: { display_name: "Tim Tsai", sms_reply_mode: "forward_owner" }, error: null }
    ]);
    const result = await sendCustomerReplyAlert(db, baseInput(fetchFn));
    expect(result).toBe("forward_owner");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a DELIVERED page for this contact inside the window coalesces", async () => {
    const fetchFn = okFetch();
    const { db, calls } = makeDb([OPTED_IN, NAMED_CONTACT, { data: [{ id: "n1" }], error: null }]);
    const result = await sendCustomerReplyAlert(db, baseInput(fetchFn));
    expect(result).toBe("coalesced");
    expect(fetchFn).not.toHaveBeenCalled();
    // The window bound is real: some gte() call received an ISO timestamp
    // no older than the coalesce window.
    const gte = calls.find((c) => c.name === "gte");
    const since = Date.parse(String(gte?.args[1] ?? ""));
    expect(Date.now() - since).toBeLessThanOrEqual(
      CUSTOMER_REPLY_COALESCE_MINUTES * 60_000 + 5_000
    );
  });

  it("a coalesce lookup error logs and still alerts (silence is the worse failure)", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([OPTED_IN, NAMED_CONTACT, { data: null, error: { message: "boom" } }]);
    expect(await sendCustomerReplyAlert(db, baseInput(fetchFn))).toBe("sent");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a null coalesce result (no rows, no error) alerts", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([OPTED_IN, NAMED_CONTACT, { data: null, error: null }]);
    expect(await sendCustomerReplyAlert(db, baseInput(fetchFn))).toBe("sent");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("defaults to the global fetch when no fetchFn is injected", async () => {
    const globalFetch = okFetch();
    vi.stubGlobal("fetch", globalFetch);
    try {
      const { db } = makeDb([OPTED_IN, NAMED_CONTACT, NO_PRIOR]);
      const result = await sendCustomerReplyAlert(
        db,
        baseInput(undefined as never, { fetchFn: undefined })
      );
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
    const { db } = makeDb([OPTED_IN, NAMED_CONTACT, NO_PRIOR]);
    expect(await sendCustomerReplyAlert(db, baseInput(fetchFn))).toBe("post_failed");
  });

  it("a thrown fetch reports post_failed and never throws", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { db } = makeDb([OPTED_IN, NAMED_CONTACT, NO_PRIOR]);
    expect(await sendCustomerReplyAlert(db, baseInput(fetchFn))).toBe("post_failed");
  });
});
