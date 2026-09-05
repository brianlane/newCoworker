/**
 * Owner alert for an email the coworker sent to a contact that bounced
 * (src/lib/notifications/contact-email-bounce-notify.ts).
 *
 * The lookups are the interesting part. The motivating case could not be
 * matched by address at all: the lead's contact carried the FORM email and
 * the booking used a different one, so the sending run's context was the only
 * road to the lead's phone, and the phone is what the owner needed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatch, hasRecent, createSupabaseServiceClient, warn, defaultDb } = vi.hoisted(() => {
  const defaultDb = { from: vi.fn() };
  return {
    dispatch: vi.fn(),
    hasRecent: vi.fn(),
    warn: vi.fn(),
    defaultDb,
    createSupabaseServiceClient: vi.fn(async () => defaultDb)
  };
});
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchUrgentNotification: dispatch }));
vi.mock("@/lib/db/notifications", () => ({ hasRecentNotificationForContact: hasRecent }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient }));
vi.mock("@/lib/logger", () => ({ logger: { warn } }));

import {
  isCustomerFacingEmailSource,
  notifyContactEmailBounce
} from "@/lib/notifications/contact-email-bounce-notify";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+13023538730";

/**
 * A Supabase double that answers `from(table)` from a per-table queue of
 * responses, in call order, and records every filter so a test can assert
 * WHICH lookup ran. Every chain method returns the same object; awaiting it
 * (or `.maybeSingle()`) yields the next scripted response for that table.
 */
type Scripted = { data: unknown; error?: unknown };
function scriptedDb(script: Record<string, Scripted[]>) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
  const from = vi.fn((table: string) => {
    const queue = script[table] ?? [];
    const response = queue.shift() ?? { data: null, error: null };
    const record = { table, ops: [] as Array<[string, unknown[]]> };
    calls.push(record);
    const chain: Record<string, unknown> = {};
    for (const op of ["select", "eq", "ilike", "or", "order", "limit"]) {
      chain[op] = (...args: unknown[]) => {
        record.ops.push([op, args]);
        return chain;
      };
    }
    chain.maybeSingle = () => Promise.resolve(response);
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(response).then(resolve);
    return chain;
  });
  return { db: { from } as never, from, calls };
}

const sent = (channel: string, status = "sent") => ({ channel, status, notificationId: "n" });

const input = {
  businessId: BIZ,
  emailLogId: "log-1",
  address: "Benjamin@Dead.example",
  subject: "Confirmed: Strategy Call with Liz",
  status: "bounced" as const,
  errorCode: "Permanent",
  runId: "run-1",
  flowId: "flow-1"
};

beforeEach(() => {
  dispatch.mockReset();
  dispatch.mockResolvedValue({ results: [sent("dashboard"), sent("email")] });
  hasRecent.mockReset();
  hasRecent.mockResolvedValue(false);
  warn.mockClear();
  createSupabaseServiceClient.mockClear();
});

describe("isCustomerFacingEmailSource", () => {
  it("counts every coworker and owner-by-hand send to a contact", () => {
    // Pinned as literals so a deleted Set member cannot hide behind the
    // export the production function already iterates.
    for (const source of [
      "ai_flow",
      "tenant_mailbox_outbound",
      "dashboard_chat",
      "sms_assistant",
      "voice_assistant",
      "slack_assistant",
      "telegram_assistant",
      "teams_assistant",
      "google_chat_assistant",
      "email_coworker",
      "booking_reminder",
      "owner_manual"
    ]) {
      expect(isCustomerFacingEmailSource(source)).toBe(true);
    }
    expect(isCustomerFacingEmailSource("tenant_mailbox_outbound")).toBe(true);
    expect(isCustomerFacingEmailSource("ai_flow")).toBe(true);
    expect(isCustomerFacingEmailSource("owner_manual")).toBe(true);
  });

  it("excludes mail TO the owner, the mixed owner mailbox, and inbound rows", () => {
    // A bounced owner alert is HQ's problem; echoing it to the bounced
    // address would be the one place it cannot land.
    expect(isCustomerFacingEmailSource("notification")).toBe(false);
    // Outreach pitches leave through here and are retired on bounce already.
    expect(isCustomerFacingEmailSource("owner_mailbox")).toBe(false);
    expect(isCustomerFacingEmailSource("email_trigger")).toBe(false);
    expect(isCustomerFacingEmailSource("tenant_mailbox_inbound")).toBe(false);
    expect(isCustomerFacingEmailSource(null)).toBe(false);
    expect(isCustomerFacingEmailSource(undefined)).toBe(false);
  });
});

describe("notifyContactEmailBounce", () => {
  it("finds the contact by address and pages whoever owns them", async () => {
    const { db, calls } = scriptedDb({
      contacts: [
        {
          data: [{ customer_e164: PHONE, display_name: "Benjamin Dobrzynski", email: "benjamin@dead.example" }]
        }
      ]
    });
    const result = await notifyContactEmailBounce(input, { client: db });
    expect(result).toEqual({ outcome: "alerted", contactE164: PHONE });

    // One lookup, case-insensitive, address escaped as a literal.
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("contacts");
    expect(calls[0].ops).toContainEqual(["ilike", ["email", "Benjamin@Dead.example"]]);

    expect(hasRecent).toHaveBeenCalledWith(
      BIZ,
      "contact_email_bounce",
      PHONE,
      24 * 60 * 60 * 1000,
      db
    );
    const call = dispatch.mock.calls[0][0];
    expect(call).toEqual(
      expect.objectContaining({
        businessId: BIZ,
        kind: "contact_email_bounce",
        contactE164: PHONE,
        summary: "Email to Benjamin Dobrzynski did not arrive (Benjamin@Dead.example)",
        ctaPath: "/dashboard/customers/%2B13023538730"
      })
    );
    expect(call.smsBody).toContain("(302) 353-8730");
    // The contact's email IS the bounced address, so no alternate is offered.
    expect(call.payload).toEqual(
      expect.objectContaining({
        email_log_id: "log-1",
        address: "Benjamin@Dead.example",
        email_subject: "Confirmed: Strategy Call with Liz",
        delivery_status: "bounced",
        delivery_error_code: "Permanent",
        run_id: "run-1",
        flow_id: "flow-1",
        other_email: null,
        to_e164: PHONE
      })
    );
    // The email copy comes from the template and only from the template.
    expect(call.emailSubject).toBeUndefined();
    expect(call.emailBody).toBeUndefined();
    const es = call.emailTemplate("es");
    expect(es.subject).toContain("no llegó");
    expect(es.ctaPath).toBe("/dashboard/customers/%2B13023538730");
    const en = call.emailTemplate("en");
    expect(en.heading).toBe("An email to Benjamin Dobrzynski did not arrive");
  });

  it("falls through to the sending run's lead phone when no contact carries the address", async () => {
    // The live case: the contact was filed under the lead-form email, the
    // booking used a work address, so both address lookups miss. The run
    // knows the lead's phone, and the phone finds the contact (and with it
    // the OTHER address, which is the useful line in the alert).
    const { db, calls } = scriptedDb({
      contacts: [
        { data: [] }, // by email
        { data: [] }, // by email key
        {
          data: [
            // Alias hit listed first; the exact match must still win.
            { customer_e164: "+15550000000", display_name: "Wrong Row", email: null },
            { customer_e164: PHONE, display_name: "Benjamin Dobrzynski", email: "b_dobrzynski@hotmail.example" }
          ]
        }
      ],
      ai_flow_runs: [
        { data: { context: { vars: { lead_phone: PHONE }, trigger: { phone_number: "+19998887777" } } } }
      ]
    });
    const result = await notifyContactEmailBounce(input, { client: db });
    expect(result).toEqual({ outcome: "alerted", contactE164: PHONE });

    expect(calls.map((c) => c.table)).toEqual(["contacts", "contacts", "ai_flow_runs", "contacts"]);
    expect(calls[1].ops).toContainEqual(["eq", ["customer_e164", "email:benjamin@dead.example"]]);
    expect(calls[2].ops).toContainEqual(["eq", ["id", "run-1"]]);
    expect(calls[2].ops).toContainEqual(["eq", ["business_id", BIZ]]);
    expect(calls[3].ops).toContainEqual([
      "or",
      [`customer_e164.eq.${PHONE},alias_e164s.cs.{${PHONE}}`]
    ]);

    const call = dispatch.mock.calls[0][0];
    expect(call.contactE164).toBe(PHONE);
    expect(call.summary).toContain("Benjamin Dobrzynski");
    expect(call.payload.other_email).toBe("b_dobrzynski@hotmail.example");
    expect(call.emailTemplate("en").body).toContain(
      "Another address on their record: b_dobrzynski@hotmail.example"
    );
  });

  it("uses the run's phone on its own when no contact row matches it", async () => {
    const { db } = scriptedDb({
      contacts: [{ data: null }, { data: [] }, { data: [] }],
      ai_flow_runs: [{ data: { context: { vars: { lead_phone: "none" }, trigger: { from: PHONE } } } }]
    });
    const result = await notifyContactEmailBounce(input, { client: db });
    expect(result).toEqual({ outcome: "alerted", contactE164: PHONE });
    const call = dispatch.mock.calls[0][0];
    // No name anywhere: the address stands in for the person.
    expect(call.summary).toBe("Email to Benjamin@Dead.example did not arrive (Benjamin@Dead.example)");
    expect(call.contactE164).toBe(PHONE);
    expect(call.payload.other_email).toBeNull();
  });

  it("prefers the extracted lead phone over the raw trigger fields, skipping undialable values", async () => {
    const { db } = scriptedDb({
      contacts: [{ data: [] }, { data: [] }, { data: [] }],
      ai_flow_runs: [
        {
          data: {
            context: {
              vars: { lead_phone: "   ", customer_phone: "73339" },
              trigger: { phone_number: "email:x@y.z", from: "+16025550100" }
            }
          }
        }
      ]
    });
    const result = await notifyContactEmailBounce(input, { client: db });
    // Blank, a short code, and an email key are all undialable; `from` wins.
    expect(result.contactE164).toBe("+16025550100");
  });

  it("keeps an email-keyed contact owner-addressed: there is no number to route on", async () => {
    const { db } = scriptedDb({
      contacts: [
        { data: [] },
        { data: [{ customer_e164: "email:benjamin@dead.example", display_name: "Benjamin", email: "benjamin@dead.example" }] }
      ]
    });
    const result = await notifyContactEmailBounce(input, { client: db });
    expect(result).toEqual({ outcome: "alerted", contactE164: null });
    // No phone means no per-contact throttle key, so no throttle read.
    expect(hasRecent).not.toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.contactE164).toBeNull();
    expect(call.ctaPath).toBe("/dashboard/emails");
    expect(call.payload).not.toHaveProperty("to_e164");
    expect(call.summary).toContain("Benjamin");
  });

  it("still alerts the owner when nothing identifies the contact at all", async () => {
    const { db, calls } = scriptedDb({ contacts: [{ data: [] }, { data: [] }] });
    const result = await notifyContactEmailBounce({ ...input, runId: null }, { client: db });
    expect(result).toEqual({ outcome: "alerted", contactE164: null });
    // No run to consult, so no ai_flow_runs read.
    expect(calls.map((c) => c.table)).toEqual(["contacts", "contacts"]);
    expect(dispatch.mock.calls[0][0].summary).toBe(
      "Email to Benjamin@Dead.example did not arrive (Benjamin@Dead.example)"
    );
  });

  it("treats a null data payload from any lookup as no rows", async () => {
    // PostgREST hands back `data: null` (not `[]`) on some empty reads; each
    // lookup must read that as "nothing here" and keep going.
    const { db, calls } = scriptedDb({
      contacts: [{ data: [] }, { data: null }, { data: null }],
      ai_flow_runs: [{ data: { context: { vars: { lead_phone: PHONE } } } }]
    });
    const result = await notifyContactEmailBounce(input, { client: db });
    expect(result).toEqual({ outcome: "alerted", contactE164: PHONE });
    expect(calls.map((c) => c.table)).toEqual(["contacts", "contacts", "ai_flow_runs", "contacts"]);
    expect(dispatch.mock.calls[0][0].payload.other_email).toBeNull();
  });

  it("names the contact by address when the matched row carries no display name", async () => {
    const { db } = scriptedDb({
      contacts: [{ data: [{ customer_e164: PHONE, display_name: null, email: "  " }] }]
    });
    const result = await notifyContactEmailBounce(input, { client: db });
    expect(result).toEqual({ outcome: "alerted", contactE164: PHONE });
    const call = dispatch.mock.calls[0][0];
    expect(call.summary).toBe("Email to Benjamin@Dead.example did not arrive (Benjamin@Dead.example)");
    // A blank email on the row is not an alternate address.
    expect(call.payload.other_email).toBeNull();
  });

  it("skips the email-key lookup for an address that cannot be a key", async () => {
    const { db, calls } = scriptedDb({ contacts: [{ data: [] }] });
    await notifyContactEmailBounce({ ...input, address: "not an address", runId: null }, { client: db });
    expect(calls).toHaveLength(1);
    expect(dispatch).toHaveBeenCalled();
  });

  it("gives up on the run path when the run is gone or names no phone", async () => {
    for (const run of [{ data: null }, { data: { context: {} } }, { data: { context: { vars: { lead_phone: 42 } } } }]) {
      dispatch.mockClear();
      const { db } = scriptedDb({ contacts: [{ data: [] }, { data: [] }], ai_flow_runs: [run] });
      const result = await notifyContactEmailBounce(input, { client: db });
      expect(result.contactE164).toBeNull();
      expect(dispatch.mock.calls[0][0].contactE164).toBeNull();
    }
  });

  it("does not page twice about the same contact inside the throttle window", async () => {
    hasRecent.mockResolvedValue(true);
    const { db } = scriptedDb({
      contacts: [{ data: [{ customer_e164: PHONE, display_name: "B", email: null }] }]
    });
    expect(await notifyContactEmailBounce(input, { client: db })).toEqual({
      outcome: "alerted_earlier",
      contactE164: PHONE
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("delivers when the throttle read itself fails", async () => {
    hasRecent.mockRejectedValue(new Error("notifications down"));
    const { db } = scriptedDb({
      contacts: [{ data: [{ customer_e164: PHONE, display_name: "B", email: null }] }]
    });
    expect((await notifyContactEmailBounce(input, { client: db })).outcome).toBe("alerted");
    expect(warn).toHaveBeenCalledWith(
      "contact-email-bounce: throttle check failed; delivering",
      expect.objectContaining({ error: "notifications down" })
    );
    hasRecent.mockRejectedValue("not an error");
    expect((await notifyContactEmailBounce(input, { client: scriptedDb({
      contacts: [{ data: [{ customer_e164: PHONE, display_name: "B", email: null }] }]
    }).db })).outcome).toBe("alerted");
  });

  it("reports not_delivered when no channel accepted the page", async () => {
    dispatch.mockResolvedValue({ results: [sent("email", "failed"), sent("sms", "skipped")] });
    const { db } = scriptedDb({ contacts: [{ data: [] }, { data: [] }] });
    expect(await notifyContactEmailBounce({ ...input, runId: null }, { client: db })).toEqual({
      outcome: "not_delivered",
      contactE164: null
    });
  });

  it("never throws back into the webhook", async () => {
    dispatch.mockRejectedValue(new Error("dispatch down"));
    const { db } = scriptedDb({
      contacts: [{ data: [{ customer_e164: PHONE, display_name: "B", email: null }] }]
    });
    expect(await notifyContactEmailBounce(input, { client: db })).toEqual({
      outcome: "failed",
      contactE164: PHONE
    });
    expect(warn).toHaveBeenCalledWith(
      "contact-email-bounce: alert failed (receipt already recorded)",
      expect.objectContaining({ businessId: BIZ, emailLogId: "log-1", error: "dispatch down" })
    );

    dispatch.mockRejectedValue("not an error");
    expect(
      (await notifyContactEmailBounce(input, {
        client: scriptedDb({ contacts: [{ data: [{ customer_e164: PHONE, display_name: "B", email: null }] }] }).db
      })).outcome
    ).toBe("failed");
  });

  it("falls back to the service client and the real collaborators when none are injected", async () => {
    const { from } = scriptedDb({ contacts: [{ data: [] }, { data: [] }] });
    defaultDb.from.mockImplementation(from);
    expect((await notifyContactEmailBounce({ ...input, runId: null })).outcome).toBe("alerted");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalled();
  });
});
