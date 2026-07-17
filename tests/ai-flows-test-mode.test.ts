import { describe, expect, it } from "vitest";
import {
  TEST_MODE_TRIGGER_KEY,
  TEST_REPLY_TEXT,
  isTestModeTrigger,
  simulateTestAction
} from "../supabase/functions/_shared/ai_flows/test_mode";
import { NO_REPLY_SENTINEL, type StepAction } from "../supabase/functions/_shared/ai_flows/steps";

/**
 * Test runs: side-effecting actions are simulated (their rendered output is
 * the step result), waits resolve instantly, and read-only/pure actions run
 * for real (simulateTestAction returns null for those).
 */

describe("isTestModeTrigger", () => {
  it("true only for a literal true flag", () => {
    expect(isTestModeTrigger({ [TEST_MODE_TRIGGER_KEY]: true })).toBe(true);
    expect(isTestModeTrigger({ [TEST_MODE_TRIGGER_KEY]: "true" })).toBe(false);
    expect(isTestModeTrigger({})).toBe(false);
    expect(isTestModeTrigger(undefined)).toBe(false);
  });
});

describe("simulateTestAction: send_whatsapp", () => {
  it("simulates sends (recipient precedence) and honors planner skips", () => {
    expect(
      simulateTestAction(
        { kind: "send_whatsapp", to: "+16025550111", body: "Hi Joe!" } as StepAction,
        { vars: {} }
      )
    ).toEqual({ simulated: "send_whatsapp", to: "+16025550111", body: "Hi Joe!" });

    expect(
      simulateTestAction(
        { kind: "send_whatsapp", to: "", toAgentName: "Dave", body: "x" } as StepAction,
        { vars: {} }
      )
    ).toEqual({ simulated: "send_whatsapp", to: "Dave", body: "x" });

    expect(
      simulateTestAction(
        {
          kind: "send_whatsapp",
          to: "",
          toRef: { source: "contact", id: "id", label: "Joe" },
          body: "x"
        } as StepAction,
        { vars: {} }
      )
    ).toEqual({ simulated: "send_whatsapp", to: "Joe", body: "x" });

    expect(
      simulateTestAction(
        { kind: "send_whatsapp", to: "", body: "x", skipReason: "no_recipient_phone" } as StepAction,
        { vars: {} }
      )
    ).toEqual({ simulated: "send_whatsapp", skipped: "no_recipient_phone" });
  });
});

describe("simulateTestAction", () => {
  const scope = () => ({ vars: {} as Record<string, unknown> });

  it("simulates doc_extract with placeholder vars (skip mirrors the live empty stamp)", () => {
    const s = scope();
    expect(
      simulateTestAction(
        {
          kind: "doc_extract",
          sourceRef: "email-attachments:inbound/m/0-renewal.pdf",
          fields: [{ name: "renewal_date" }],
          fileTitle: "Renewal"
        } as StepAction,
        s
      )
    ).toEqual({
      simulated: "doc_extract",
      source: "email-attachments:inbound/m/0-renewal.pdf",
      saved: { renewal_date: "(test run: renewal_date from document)" },
      would_file_as: "Renewal"
    });
    expect(s.vars.renewal_date).toBe("(test run: renewal_date from document)");

    // Without a filing title, no would_file_as key appears.
    expect(
      simulateTestAction(
        {
          kind: "doc_extract",
          sourceRef: "email-attachments:inbound/m/0-a.pdf",
          fields: [{ name: "x" }]
        } as StepAction,
        scope()
      )
    ).not.toHaveProperty("would_file_as");

    const skipped = scope();
    expect(
      simulateTestAction(
        {
          kind: "doc_extract",
          sourceRef: "",
          fields: [{ name: "renewal_date" }],
          skipReason: "no document on this trigger to read"
        } as StepAction,
        skipped
      )
    ).toEqual({ simulated: "doc_extract", skipped: "no document on this trigger to read" });
    expect(skipped.vars.renewal_date).toBe("");
  });

  it("doc_extract record sinks report intent (link / stamp / renewal)", () => {
    const withPhone = simulateTestAction(
      {
        kind: "doc_extract",
        sourceRef: "email-attachments:inbound/m/0-quote.pdf",
        fields: [{ name: "renewal_date" }],
        fileTitle: "Quote",
        fileContactPhone: "+16025551234",
        fileRecordFields: true,
        fileRenewalField: "renewal_date"
      } as StepAction,
      scope()
    );
    expect(withPhone).toMatchObject({
      would_link_contact: "+16025551234",
      would_stamp_record_fields: true,
      would_set_renewal_from: "renewal_date"
    });

    const emptyPhone = simulateTestAction(
      {
        kind: "doc_extract",
        sourceRef: "email-attachments:inbound/m/0-quote.pdf",
        fields: [{ name: "x" }],
        fileTitle: "Quote",
        fileContactPhone: ""
      } as StepAction,
      scope()
    );
    expect(emptyPhone).toMatchObject({ would_link_contact: "(no phone value)" });

    const fromField = simulateTestAction(
      {
        kind: "doc_extract",
        sourceRef: "email-attachments:inbound/m/0-quote.pdf",
        fields: [{ name: "customer_phone" }],
        fileTitle: "Quote",
        fileContactField: "customer_phone"
      } as StepAction,
      scope()
    );
    expect(fromField).toMatchObject({
      would_link_contact: 'from extracted field "customer_phone"'
    });
  });

  it("simulates every send with its fully-rendered content", () => {
    expect(
      simulateTestAction(
        { kind: "send_sms", to: "+16025550111", body: "Hi Joe!" } as StepAction,
        scope()
      )
    ).toEqual({ simulated: "send_sms", to: "+16025550111", body: "Hi Joe!" });

    // Recipient display precedence: named agent > saved ref > to > group.
    expect(
      simulateTestAction(
        { kind: "send_sms", to: "", toAgentName: "Dania", body: "b" } as StepAction,
        scope()
      )
    ).toMatchObject({ to: "Dania" });
    expect(
      simulateTestAction(
        { kind: "send_sms", to: "", toRef: { source: "contact", id: "x", label: "Joe" }, body: "b" } as StepAction,
        scope()
      )
    ).toMatchObject({ to: "Joe" });
    expect(
      simulateTestAction({ kind: "send_sms", to: "", body: "b" } as StepAction, scope())
    ).toMatchObject({ to: "(group thread)" });

    // A planner SKIP (templated recipient resolved to nothing usable) reads
    // as the skip the live run would record — never as a successful send to
    // the "(group thread)" display fallback.
    expect(
      simulateTestAction(
        { kind: "send_sms", to: "", body: "b", skipReason: "no_recipient_phone" } as StepAction,
        scope()
      )
    ).toEqual({ simulated: "send_sms", skipped: "no_recipient_phone" });

    expect(
      simulateTestAction(
        { kind: "send_email", to: "a@b.co", subject: "s", body: "b", attachScreenshot: false } as StepAction,
        scope()
      )
    ).toEqual({ simulated: "send_email", to: "a@b.co", subject: "s", body: "b" });

    expect(
      simulateTestAction({ kind: "notify_owner", message: "m" } as StepAction, scope())
    ).toEqual({ simulated: "notify_owner", message: "m" });

    expect(
      simulateTestAction(
        { kind: "http_call", label: "crm", method: "POST", path: "/x", body: "{}" } as StepAction,
        scope()
      )
    ).toEqual({ simulated: "http_call", label: "crm", method: "POST", path: "/x", body: "{}" });
  });

  it("auto-approves gates and records the would-be team offer", () => {
    expect(
      simulateTestAction({ kind: "await_approval", prompt: "ok?" } as StepAction, scope())
    ).toEqual({ simulated: "approval_gate", decision: "auto_approved_test", prompt: "ok?" });
    expect(
      simulateTestAction(
        {
          kind: "route_to_team",
          offerTemplate: "New lead!",
          responseMinutes: 10,
          ownerFallbackTemplate: "back to you",
          attachScreenshot: false
        } as StepAction,
        scope()
      )
    ).toEqual({ simulated: "route_to_team", offer: "New lead!" });
  });

  it("simulates CRM writes and page actions without touching anything", () => {
    expect(
      simulateTestAction(
        { kind: "upsert_customer", e164: "+1602", name: "Joe", email: "" } as StepAction,
        scope()
      )
    ).toEqual({ simulated: "upsert_customer", customer_e164: "+1602", name: "Joe" });
    expect(
      simulateTestAction(
        { kind: "update_contact", e164: "+1602", addTags: ["A"], removeTags: [] } as StepAction,
        scope()
      )
    ).toEqual({ simulated: "update_contact", customer_e164: "+1602", addTags: ["A"], removeTags: [] });
    expect(
      simulateTestAction(
        {
          kind: "browse_action",
          url: "https://x",
          actions: [{ kind: "click_text", target: "Accept", value: "" }],
          screenshot: false
        } as StepAction,
        scope()
      )
    ).toEqual({ simulated: "browse_action", url: "https://x", actions: ["click_text: Accept"] });
  });

  it("share_document mints nothing but stamps a placeholder link into saveAs", () => {
    const s = scope();
    expect(
      simulateTestAction(
        {
          kind: "share_document",
          documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          via: "sms",
          to: "+16025550111",
          message: "here: {{share_url}}",
          saveAs: "doc_url"
        } as StepAction,
        s
      )
    ).toEqual({
      simulated: "share_document",
      documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      via: "sms",
      to: "+16025550111",
      message: "here: {{share_url}}"
    });
    expect(s.vars.doc_url).toBe("https://example.invalid/test-share-link");

    // Without saveAs nothing is stamped; an empty recipient renders honestly.
    const s2 = scope();
    expect(
      simulateTestAction(
        {
          kind: "share_document",
          documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          via: "email",
          to: "",
          message: ""
        } as StepAction,
        s2
      )
    ).toMatchObject({ to: "(no recipient)" });
    expect(Object.keys(s2.vars)).toHaveLength(0);

    // A planner SKIP mirrors the live path: no simulated share, no
    // placeholder link stamped for a message that would never send.
    const s3 = scope();
    expect(
      simulateTestAction(
        {
          kind: "share_document",
          documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          via: "sms",
          to: "",
          message: "here: {{share_url}}",
          saveAs: "doc_url",
          skipReason: "no_recipient"
        } as StepAction,
        s3
      )
    ).toEqual({ simulated: "share_document", skipped: "no_recipient" });
    expect(Object.keys(s3.vars)).toHaveLength(0);
  });

  it("generate_image leaves the saveAs var empty so MMS degrades like a live failure", () => {
    const s = scope();
    expect(
      simulateTestAction(
        { kind: "generate_image", prompt: "a flyer", saveAs: "flyer_url" } as StepAction,
        s
      )
    ).toEqual({ simulated: "generate_image", prompt: "a flyer" });
    expect(s.vars.flyer_url).toBe("");
  });

  it("waits resolve instantly with their markers stamped", () => {
    const s1 = scope();
    expect(
      simulateTestAction(
        { kind: "sleep", minutes: 300, marker: "__slept_z" } as StepAction,
        s1
      )
    ).toEqual({ simulated: "sleep", skipped_wait: true });
    expect(s1.vars.__slept_z).toBe("1");

    const s2 = scope();
    const res = simulateTestAction(
      {
        kind: "wait_for_reply",
        from: "+1602",
        saveAs: "reply_text",
        marker: "__waited_w",
        timeoutMinutes: 60
      } as StepAction,
      s2
    );
    expect(res).toEqual({
      simulated: "wait_for_reply",
      saved: { reply_text: TEST_REPLY_TEXT },
      no_reply_sentinel: NO_REPLY_SENTINEL
    });
    expect(s2.vars.reply_text).toBe(TEST_REPLY_TEXT);
    expect(s2.vars.__waited_w).toBe("1");
  });

  it("read-only / pure actions run for real (null)", () => {
    for (const action of [
      { kind: "set_vars", vars: {} },
      { kind: "browse", url: "https://x" },
      { kind: "extract_text", text: "t", fields: [] },
      { kind: "classify", text: "t", categories: [], saveAs: "x" },
      { kind: "recall_url", keys: [], saveAs: "u" },
      { kind: "goal", label: "Booked", reachedVia: "passed_inline" }
    ] as StepAction[]) {
      expect(simulateTestAction(action, scope())).toBeNull();
    }
  });
});
