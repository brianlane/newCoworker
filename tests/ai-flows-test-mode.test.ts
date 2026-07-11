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

describe("simulateTestAction", () => {
  const scope = () => ({ vars: {} as Record<string, unknown> });

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
