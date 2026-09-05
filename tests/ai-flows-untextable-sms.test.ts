import { describe, expect, it } from "vitest";
import {
  UNTEXTABLE_SMS_VAR,
  markUntextableSmsTold,
  readUntextableSms,
  recordUntextableSms,
  regionDisplayName,
  untextableSmsNote,
  untextableSmsOwnerAlert,
  withUntextableSmsNote
} from "../supabase/functions/_shared/ai_flows/untextable_sms";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

/**
 * The bookkeeping behind "never imply the SMS ladder texted a lead it could
 * not reach" (KYP Ads / VFM, an Indian mobile, Aug 12 2026). The worker
 * records each lead-facing international skip here; the planner reads it
 * back into every owner alert that follows.
 */

const INDIAN_LEAD = "+917782876437";

describe("recordUntextableSms / readUntextableSms", () => {
  it("reads nothing when no skip has been recorded, or the var is unreadable", () => {
    expect(readUntextableSms(undefined)).toBeNull();
    expect(readUntextableSms({})).toBeNull();
    expect(readUntextableSms({ [UNTEXTABLE_SMS_VAR]: "" })).toBeNull();
    expect(readUntextableSms({ [UNTEXTABLE_SMS_VAR]: 42 })).toBeNull();
    expect(readUntextableSms({ [UNTEXTABLE_SMS_VAR]: "{not json" })).toBeNull();
    expect(readUntextableSms({ [UNTEXTABLE_SMS_VAR]: "[1,2]" })).toBeNull();
    expect(readUntextableSms({ [UNTEXTABLE_SMS_VAR]: JSON.stringify({ to: "" }) })).toBeNull();
  });

  it("stores the first skip as a JSON string engine var and reads it back", () => {
    const vars: Record<string, unknown> = {};
    const state = recordUntextableSms(vars, {
      to: INDIAN_LEAD,
      country: "IN",
      label: "the lead",
      email: "emailed",
      emailTo: "ravi@example.com"
    });
    expect(typeof vars[UNTEXTABLE_SMS_VAR]).toBe("string");
    expect(state).toEqual({
      to: INDIAN_LEAD,
      country: "IN",
      label: "the lead",
      skipped: 1,
      emailed: 1,
      emailFailed: 0,
      emailTo: "ravi@example.com",
      told: false
    });
    expect(readUntextableSms(vars)).toEqual(state);
  });

  it("tallies repeated skips to the same number, keeping the last known address", () => {
    const vars: Record<string, unknown> = {};
    recordUntextableSms(vars, { to: INDIAN_LEAD, country: "IN", label: "the lead", email: "emailed", emailTo: "a@x.com" });
    recordUntextableSms(vars, { to: INDIAN_LEAD, country: "IN", label: "the lead", email: "email_failed", emailTo: "a@x.com" });
    // A no_email skip keeps the address the earlier rungs used.
    const state = recordUntextableSms(vars, { to: INDIAN_LEAD, country: "IN", label: "", email: "no_email" });
    expect(state).toMatchObject({ skipped: 3, emailed: 1, emailFailed: 1, emailTo: "a@x.com", label: "the lead" });
  });

  it("restarts the tally when a different number is skipped", () => {
    const vars: Record<string, unknown> = {};
    recordUntextableSms(vars, { to: INDIAN_LEAD, country: "IN", label: "the lead", email: "emailed", emailTo: "a@x.com" });
    markUntextableSmsTold(vars);
    const state = recordUntextableSms(vars, { to: "+85260100607", country: "HK", label: "Mr Chan", email: "no_email" });
    expect(state).toEqual({
      to: "+85260100607",
      country: "HK",
      label: "Mr Chan",
      skipped: 1,
      emailed: 0,
      emailFailed: 0,
      emailTo: null,
      told: false
    });
  });

  it("fills defaults for a hand-edited or older record", () => {
    const vars = { [UNTEXTABLE_SMS_VAR]: JSON.stringify({ to: INDIAN_LEAD, told: "yes" }) };
    expect(readUntextableSms(vars)).toEqual({
      to: INDIAN_LEAD,
      country: null,
      label: "the lead",
      skipped: 0,
      emailed: 0,
      emailFailed: 0,
      emailTo: null,
      told: false
    });
  });
});

describe("markUntextableSmsTold", () => {
  it("flips told once and is a no-op without a record or when already told", () => {
    const empty: Record<string, unknown> = {};
    markUntextableSmsTold(empty);
    expect(empty).toEqual({});

    const vars: Record<string, unknown> = {};
    recordUntextableSms(vars, { to: INDIAN_LEAD, country: "IN", label: "the lead", email: "no_email" });
    markUntextableSmsTold(vars);
    const once = vars[UNTEXTABLE_SMS_VAR];
    expect(readUntextableSms(vars)?.told).toBe(true);
    markUntextableSmsTold(vars);
    expect(vars[UNTEXTABLE_SMS_VAR]).toBe(once);
  });
});

describe("regionDisplayName", () => {
  it("names a real region and falls back to the code when the runtime cannot", () => {
    expect(regionDisplayName("IN")).toBe("India");
    expect(regionDisplayName("QQ")).toBe("QQ");
    expect(regionDisplayName("not-a-code")).toBe("not-a-code");
  });
});

describe("untextableSmsNote", () => {
  const base = { to: INDIAN_LEAD, country: "IN", label: "the lead", told: false };

  it("single skip, emailed instead", () => {
    const note = untextableSmsNote({ ...base, skipped: 1, emailed: 1, emailFailed: 0, emailTo: "ravi@example.com" });
    expect(note).toBe(
      `${INDIAN_LEAD} is a number in India, and this account can only text US and Canadian numbers, ` +
        "so the text to the lead in this automation was not sent. I emailed the same message to " +
        "ravi@example.com instead."
    );
  });

  it("several skips, every one emailed", () => {
    const note = untextableSmsNote({ ...base, skipped: 3, emailed: 3, emailFailed: 0, emailTo: "ravi@example.com" });
    expect(note).toContain("so the 3 texts to the lead in this automation were not sent.");
    expect(note).toContain("I emailed the same messages to ravi@example.com instead.");
  });

  it("some emailed, one did not reach them", () => {
    const note = untextableSmsNote({ ...base, skipped: 3, emailed: 2, emailFailed: 1, emailTo: "ravi@example.com" });
    expect(note).toContain("2 of 3 went by email to ravi@example.com instead; the other did not reach them.");
    const two = untextableSmsNote({ ...base, skipped: 4, emailed: 2, emailFailed: 2, emailTo: "ravi@example.com" });
    expect(two).toContain("the others did not reach them.");
  });

  it("address on file but the email failed", () => {
    const note = untextableSmsNote({ ...base, skipped: 1, emailed: 0, emailFailed: 1, emailTo: "ravi@example.com" });
    expect(note).toContain("I tried to email ravi@example.com instead, but the email failed, so they have not heard from us.");
  });

  it("no email on file, and an unrecognized country reads as outside US/CA", () => {
    const note = untextableSmsNote({ ...base, country: null, skipped: 2, emailed: 0, emailFailed: 0, emailTo: null });
    expect(note).toBe(
      `${INDIAN_LEAD} is a number outside the US and Canada, and this account can only text US and Canadian ` +
        "numbers, so the 2 texts to the lead in this automation were not sent. They have no email on " +
        "file, so they have not heard from us."
    );
  });

  it("the standalone owner alert leads with the recipient", () => {
    const alert = untextableSmsOwnerAlert({ ...base, label: "Ravi", skipped: 1, emailed: 0, emailFailed: 0, emailTo: null });
    expect(alert.startsWith("Heads up: I could not text Ravi. ")).toBe(true);
    expect(alert).toContain("the text to Ravi in this automation was not sent");
  });
});

describe("withUntextableSmsNote", () => {
  it("leaves a message alone when nothing was skipped", () => {
    expect(withUntextableSmsNote("New lead", undefined)).toBe("New lead");
    expect(withUntextableSmsNote("New lead", {})).toBe("New lead");
  });

  it("appends the note after the flow's own copy", () => {
    const vars: Record<string, unknown> = {};
    recordUntextableSms(vars, { to: INDIAN_LEAD, country: "IN", label: "the lead", email: "no_email" });
    expect(withUntextableSmsNote("I sent them the greeting.", vars)).toBe(
      `I sent them the greeting. Note: ${INDIAN_LEAD} is a number in India, and this account can only ` +
        "text US and Canadian numbers, so the text to the lead in this automation was not sent. They " +
        "have no email on file, so they have not heard from us."
    );
  });
});

describe("planStep carries the note on owner-facing alerts", () => {
  const vars: Record<string, unknown> = { lead_name: "Ravi", lead_phone: INDIAN_LEAD };
  recordUntextableSms(vars, {
    to: INDIAN_LEAD,
    country: "IN",
    label: "the lead",
    email: "emailed",
    emailTo: "ravi@example.com"
  });

  it("notify_owner: the flow's alert keeps its details and gains the truth about the text", () => {
    const step: FlowStep = {
      id: "s_notify",
      type: "notify_owner",
      message: "New lead: {{vars.lead_name}}. I sent them the greeting and I'm on follow-up duty."
    };
    const plan = planStep(step, { vars });
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.action.kind !== "notify_owner") throw new Error("unexpected plan");
    expect(plan.action.message).toBe(
      "New lead: Ravi. I sent them the greeting and I'm on follow-up duty. Note: " +
        `${INDIAN_LEAD} is a number in India, and this account can only text US and Canadian numbers, ` +
        "so the text to the lead in this automation was not sent. I emailed the same message to " +
        "ravi@example.com instead."
    );
  });

  it("notify_lead_owner: same note for whoever owns the lead", () => {
    const step: FlowStep = {
      id: "s_fwd",
      type: "notify_lead_owner",
      phoneVar: "lead_phone",
      message: "{{vars.lead_name}} hasn't replied to 3 follow-ups."
    };
    const plan = planStep(step, { vars });
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.action.kind !== "notify_lead_owner") throw new Error("unexpected plan");
    expect(plan.action.phone).toBe(INDIAN_LEAD);
    expect(plan.action.message.startsWith("Ravi hasn't replied to 3 follow-ups. Note: ")).toBe(true);
    expect(plan.action.message).toContain("I emailed the same message to ravi@example.com instead.");
  });

  it("an unrelated run's alerts are untouched", () => {
    const step: FlowStep = { id: "s_notify", type: "notify_owner", message: "New lead: {{vars.lead_name}}." };
    expect(planStep(step, { vars: { lead_name: "Ravi" } })).toEqual({
      ok: true,
      action: { kind: "notify_owner", message: "New lead: Ravi." }
    });
  });
});
