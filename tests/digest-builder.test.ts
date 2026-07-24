import { describe, expect, it } from "vitest";
import {
  AI_FLOW_RECAP_MAX_RUNS,
  DIGEST_EVENT_LINKS_MAX,
  buildAiFlowRecapLine,
  buildDigestEmailModel,
  buildDigestEventLinks,
  groupSmsThreads,
  hasCustomerFacingDigestActivity,
  hasDigestActivity,
  isRenderableSmsSender,
  routingSummary,
  smsCounterpartFromPayload,
  totalDigestEvents,
  windowLabel,
  type DigestActivity,
  type DigestAiFlowRun
} from "../supabase/functions/_shared/digest_builder.ts";

function emptyActivity(): DigestActivity {
  return {
    chatTurns: 0,
    smsInbound: 0,
    smsOutbound: 0,
    smsThreads: [],
    calls: [],
    aiFlowRuns: [],
    newCustomers: [],
    urgentAlerts: 0,
    notificationsDelivered: 0
  };
}

function makeRun(overrides: Partial<DigestAiFlowRun> = {}): DigestAiFlowRun {
  return {
    flowName: "Lead intake",
    status: "done",
    created_at: "2026-06-11T12:00:00Z",
    context: {},
    ...overrides
  };
}

describe("digest_builder routingSummary", () => {
  it("returns null when context has no routing", () => {
    expect(routingSummary({})).toBeNull();
  });

  it("returns null when routing is not an object", () => {
    expect(routingSummary({ routing: "weird" })).toBeNull();
  });

  it("returns null when there are no offers at all", () => {
    expect(routingSummary({ routing: { tried: [] } })).toBeNull();
  });

  it("summarizes a claimed run with claimed_name (singular agent)", () => {
    expect(
      routingSummary({ routing: { claimed_name: "Gabrielle Mota", claimed_by: "+15550001111" } })
    ).toBe("offered to 1 agent · claimed by Gabrielle Mota");
  });

  it("falls back to claimed_by when claimed_name missing", () => {
    expect(routingSummary({ routing: { tried: ["a", "b"], claimed_by: "+15550001111" } })).toBe(
      "offered to 3 agents · claimed by +15550001111"
    );
  });

  it("reports awaiting reply for a live offer", () => {
    expect(routingSummary({ routing: { tried: ["a"], offered: "+15552223333" } })).toBe(
      "offered to 2 agents · awaiting reply"
    );
  });

  it("reports owner fallback when offers exhausted with no claim", () => {
    expect(routingSummary({ routing: { tried: ["a", "b"], offered: "" } })).toBe(
      "offered to 2 agents · no claim (owner fallback)"
    );
  });
});

describe("digest_builder buildAiFlowRecapLine", () => {
  it("renders flow name and status alone for an empty context", () => {
    expect(buildAiFlowRecapLine(makeRun())).toBe("Lead intake, done");
  });

  it("includes routing, lead fields, and actions_taken", () => {
    const line = buildAiFlowRecapLine(
      makeRun({
        context: {
          routing: { claimed_name: "Gabrielle" },
          vars: {
            lead_name: "Sam Seller",
            phone: "+15558675309",
            lead_email: "sam@example.com",
            actions_taken: "Sent intro SMS; booked walkthrough"
          }
        }
      })
    );
    expect(line).toBe(
      "Lead intake, done · offered to 1 agent · claimed by Gabrielle · " +
        "lead: Sam Seller, +15558675309, sam@example.com · " +
        "Sent intro SMS; booked walkthrough"
    );
  });

  it("prefers lead_* keys over bare aliases and skips blank/non-string values", () => {
    const line = buildAiFlowRecapLine(
      makeRun({
        context: {
          vars: { lead_name: "  ", name: "Alias Name", lead_phone: 12345, email: "e@x.com" }
        }
      })
    );
    // lead_name blank -> falls to name alias; lead_phone non-string -> phone
    // alias absent; lead_email absent -> email alias.
    expect(line).toBe("Lead intake, done · lead: Alias Name, e@x.com");
  });

  it("truncates an over-long actions_taken log", () => {
    const actions = "x".repeat(500);
    const line = buildAiFlowRecapLine(makeRun({ context: { vars: { actions_taken: actions } } }));
    const tail = line.split(" · ")[1];
    expect(tail.length).toBe(220);
    expect(tail.endsWith("…")).toBe(true);
  });

  it("ignores empty or non-string actions_taken", () => {
    expect(
      buildAiFlowRecapLine(makeRun({ context: { vars: { actions_taken: "   " } } }))
    ).toBe("Lead intake, done");
    expect(
      buildAiFlowRecapLine(makeRun({ context: { vars: { actions_taken: 42 } } }))
    ).toBe("Lead intake, done");
  });
});

describe("digest_builder activity totals", () => {
  it("counts every customer-visible surface", () => {
    const a: DigestActivity = {
      ...emptyActivity(),
      chatTurns: 2,
      smsInbound: 3,
      smsOutbound: 4,
      calls: [{ caller_e164: "+1", status: "completed", started_at: "t" }],
      aiFlowRuns: [makeRun()],
      newCustomers: [{ display_name: null, customer_e164: "+2" }]
    };
    expect(totalDigestEvents(a)).toBe(12);
    expect(hasDigestActivity(a)).toBe(true);
  });

  it("treats urgent alerts / notifications alone as no activity", () => {
    const a = { ...emptyActivity(), urgentAlerts: 5, notificationsDelivered: 2 };
    expect(hasDigestActivity(a)).toBe(false);
  });
});

describe("digest_builder hasCustomerFacingDigestActivity", () => {
  it("ignores routine-only windows: chat, AiFlow runs, owner-directed sends, delivered notifications", () => {
    const a: DigestActivity = {
      ...emptyActivity(),
      chatTurns: 7,
      aiFlowRuns: [makeRun(), makeRun()],
      // Owner pages only: total outbound moved, customer-directed did not.
      smsOutbound: 3,
      smsOutboundCustomer: 0,
      notificationsDelivered: 4
    };
    expect(hasDigestActivity(a)).toBe(true);
    expect(hasCustomerFacingDigestActivity(a)).toBe(false);
  });

  it("treats a missing smsOutboundCustomer as zero", () => {
    const a: DigestActivity = { ...emptyActivity(), smsOutbound: 2 };
    expect(a.smsOutboundCustomer).toBeUndefined();
    expect(hasCustomerFacingDigestActivity(a)).toBe(false);
  });

  it.each([
    ["inbound texts", { smsInbound: 1 }],
    ["customer-directed outbound texts", { smsOutboundCustomer: 1 }],
    ["calls", { calls: [{ caller_e164: "+1", status: "completed", started_at: "t" }] }],
    ["new customers", { newCustomers: [{ display_name: null, customer_e164: "+2" }] }],
    ["urgent alerts", { urgentAlerts: 1 }]
  ] as Array<[string, Partial<DigestActivity>]>)(
    "passes the gate on %s alone",
    (_label, overrides) => {
      const a: DigestActivity = { ...emptyActivity(), ...overrides };
      expect(hasCustomerFacingDigestActivity(a)).toBe(true);
    }
  );
});

describe("digest_builder windowLabel", () => {
  it("labels daily and weekly windows", () => {
    expect(windowLabel("daily")).toEqual({ title: "Daily summary", span: "the last 24 hours" });
    expect(windowLabel("weekly")).toEqual({ title: "Weekly summary", span: "the last 7 days" });
  });
});

describe("digest_builder buildDigestEmailModel", () => {
  it("builds a full daily model with every section", () => {
    const activity: DigestActivity = {
      chatTurns: 1,
      smsInbound: 2,
      smsOutbound: 3,
      smsThreads: [],
      calls: [
        { caller_e164: "+15550001111", status: "completed", started_at: "t1" },
        { caller_e164: null, status: "errored", started_at: "t2" }
      ],
      aiFlowRuns: [makeRun()],
      newCustomers: [
        { display_name: "Pat", customer_e164: "+15552220000" },
        { display_name: null, customer_e164: "+15553330000" }
      ],
      urgentAlerts: 1,
      notificationsDelivered: 4
    };
    const model = buildDigestEmailModel({
      window: "daily",
      businessName: "Acme Plumbing",
      activity
    });

    expect(model.subject).toBe("Daily summary, Acme Plumbing (11 events)");
    expect(model.intro).toContain("the last 24 hours");
    expect(model.sections.map((s) => s.heading)).toEqual([
      "Conversations",
      "Calls (2)",
      "AiFlow runs (1)",
      "New customers (2)",
      "Status"
    ]);
    const convo = model.sections[0];
    expect(convo.lines).toEqual(["Dashboard chat: 1 turn", "Texts: 2 received, 3 sent"]);
    expect(model.sections[1].lines).toEqual([
      "+15550001111, completed",
      "unknown caller, errored"
    ]);
    expect(model.sections[2].lines).toEqual(["Lead intake, done"]);
    expect(model.sections[3].lines).toEqual(["Pat (+15552220000)", "+15553330000"]);
    expect(model.sections[4].lines).toEqual([
      "Urgent alerts: 1",
      "Notifications delivered: 4"
    ]);
    expect(model.activitySummary).toBe("11 events, 2 calls, 5 texts, 1 AiFlow runs, 1 urgent");
  });

  it("pluralizes chat turns and omits empty sections", () => {
    const model = buildDigestEmailModel({
      window: "weekly",
      businessName: "Acme",
      activity: { ...emptyActivity(), chatTurns: 2 }
    });
    expect(model.subject).toBe("Weekly summary, Acme (2 events)");
    expect(model.sections.map((s) => s.heading)).toEqual(["Conversations", "Status"]);
    expect(model.sections[0].lines).toEqual(["Dashboard chat: 2 turns"]);
    expect(model.activitySummary).toBe("2 events");
  });

  it("skips the conversations section entirely when there are no chats or texts", () => {
    const model = buildDigestEmailModel({
      window: "daily",
      businessName: "Acme",
      activity: {
        ...emptyActivity(),
        calls: [{ caller_e164: "+1", status: "completed", started_at: "t" }]
      }
    });
    expect(model.subject).toContain("(1 event)");
    expect(model.sections.map((s) => s.heading)).toEqual(["Calls (1)", "Status"]);
    expect(model.activitySummary).toBe("1 events, 1 calls");
  });

  it("caps long call, run, and customer lists with overflow lines", () => {
    const calls = Array.from({ length: 12 }, (_, i) => ({
      caller_e164: `+1555000${i}`,
      status: "completed",
      started_at: "t"
    }));
    const runs = Array.from({ length: AI_FLOW_RECAP_MAX_RUNS + 2 }, () => makeRun());
    const customers = Array.from({ length: 11 }, (_, i) => ({
      display_name: null,
      customer_e164: `+1666000${i}`
    }));
    const model = buildDigestEmailModel({
      window: "daily",
      businessName: "Acme",
      activity: { ...emptyActivity(), calls, aiFlowRuns: runs, newCustomers: customers }
    });

    const callSection = model.sections.find((s) => s.heading === "Calls (12)")!;
    expect(callSection.lines).toHaveLength(11);
    expect(callSection.lines.at(-1)).toBe("…and 2 more");

    const runSection = model.sections.find((s) =>
      s.heading.startsWith("AiFlow runs")
    )!;
    expect(runSection.lines).toHaveLength(AI_FLOW_RECAP_MAX_RUNS + 1);
    expect(runSection.lines.at(-1)).toBe("…and 2 more runs");

    const custSection = model.sections.find((s) => s.heading.startsWith("New customers"))!;
    expect(custSection.lines).toHaveLength(11);
    expect(custSection.lines.at(-1)).toBe("…and 1 more");
  });
});

describe("buildDigestEventLinks", () => {
  it("returns no events for an empty window", () => {
    expect(buildDigestEventLinks(emptyActivity())).toEqual([]);
  });

  it("builds one deep link per call, run, and customer plus text/chat roll-ups", () => {
    const activity: DigestActivity = {
      ...emptyActivity(),
      chatTurns: 3,
      smsInbound: 2,
      smsOutbound: 1,
      calls: [
        { caller_e164: "+15551111111", status: "completed", started_at: "2026-06-11T10:00:00Z" },
        { caller_e164: null, status: "missed", started_at: "2026-06-11T11:00:00Z" }
      ],
      aiFlowRuns: [makeRun({ flowName: "ReferralExchange lead", status: "done" })],
      newCustomers: [
        { display_name: "Domenico Siciliano", customer_e164: "+14695555555" },
        { display_name: null, customer_e164: "+14805555555" }
      ]
    };
    const events = buildDigestEventLinks(activity);
    expect(events).toEqual([
      {
        label: "Call: +15551111111 (completed)",
        href: "/dashboard/calls",
        at: "2026-06-11T10:00:00Z"
      },
      {
        label: "Call: unknown caller (missed)",
        href: "/dashboard/calls",
        at: "2026-06-11T11:00:00Z"
      },
      {
        label: "AiFlow: ReferralExchange lead (done)",
        href: "/dashboard/aiflows",
        at: "2026-06-11T12:00:00Z"
      },
      {
        label: "New customer: Domenico Siciliano (+14695555555)",
        href: "/dashboard/customers/%2B14695555555"
      },
      {
        label: "New customer: +14805555555",
        href: "/dashboard/customers/%2B14805555555"
      },
      { label: "Texts: 2 received, 1 sent", href: "/dashboard/messages" },
      { label: "Dashboard chat: 3 turns", href: "/dashboard/chat" }
    ]);
  });

  it("uses singular wording for one chat turn and includes texts when only outbound exist", () => {
    const events = buildDigestEventLinks({
      ...emptyActivity(),
      chatTurns: 1,
      smsOutbound: 4
    });
    expect(events).toEqual([
      { label: "Texts: 0 received, 4 sent", href: "/dashboard/messages" },
      { label: "Dashboard chat: 1 turn", href: "/dashboard/chat" }
    ]);
  });

  it("caps the stored events list", () => {
    const calls = Array.from({ length: DIGEST_EVENT_LINKS_MAX + 5 }, (_, i) => ({
      caller_e164: `+1555${String(i).padStart(7, "0")}`,
      status: "completed",
      started_at: "2026-06-11T10:00:00Z"
    }));
    const events = buildDigestEventLinks({ ...emptyActivity(), calls });
    expect(events).toHaveLength(DIGEST_EVENT_LINKS_MAX);
  });

  it("emits one deep-linked event per texting thread, newest-thread first", () => {
    const events = buildDigestEventLinks({
      ...emptyActivity(),
      smsInbound: 3,
      smsOutbound: 2,
      smsThreads: [
        {
          counterpart: "+14695555555",
          inbound: 2,
          outbound: 1,
          lastAt: "2026-06-11T12:00:00Z"
        },
        { counterpart: "73339", inbound: 1, outbound: 1, lastAt: "2026-06-11T09:00:00Z" }
      ]
    });
    expect(events).toEqual([
      {
        label: "Texts with +14695555555: 2 received, 1 sent",
        href: "/dashboard/messages/%2B14695555555",
        at: "2026-06-11T12:00:00Z"
      },
      {
        label: "Texts with 73339: 1 received, 1 sent",
        href: "/dashboard/messages/73339",
        at: "2026-06-11T09:00:00Z"
      }
    ]);
  });

  it("falls back to the index roll-up when counts exist but no thread parsed", () => {
    const events = buildDigestEventLinks({
      ...emptyActivity(),
      smsInbound: 1,
      smsOutbound: 0,
      smsThreads: []
    });
    expect(events).toEqual([{ label: "Texts: 1 received, 0 sent", href: "/dashboard/messages" }]);
  });

  it("adds an index roll-up alongside per-thread links when some texts are unparsed", () => {
    const events = buildDigestEventLinks({
      ...emptyActivity(),
      // 3 inbound counted but only 2 mapped to a thread -> 1 unparsed.
      smsInbound: 3,
      smsOutbound: 1,
      smsThreads: [
        { counterpart: "+14695555555", inbound: 2, outbound: 1, lastAt: "2026-06-11T12:00:00Z" }
      ]
    });
    expect(events).toEqual([
      {
        label: "Texts with +14695555555: 2 received, 1 sent",
        href: "/dashboard/messages/%2B14695555555",
        at: "2026-06-11T12:00:00Z"
      },
      { label: "Texts: 3 received, 1 sent", href: "/dashboard/messages" }
    ]);
  });

  it("reserves the text roll-up and chat from the cap when detail overflows", () => {
    const calls = Array.from({ length: DIGEST_EVENT_LINKS_MAX + 5 }, (_, i) => ({
      caller_e164: `+1555${String(i).padStart(7, "0")}`,
      status: "completed",
      started_at: "2026-06-11T10:00:00Z"
    }));
    const events = buildDigestEventLinks({
      ...emptyActivity(),
      chatTurns: 2,
      smsInbound: 4,
      smsOutbound: 0,
      smsThreads: [
        { counterpart: "+19998887777", inbound: 4, outbound: 0, lastAt: "2026-06-11T11:00:00Z" }
      ],
      calls
    });
    expect(events).toHaveLength(DIGEST_EVENT_LINKS_MAX);
    // Even buried behind 35 calls, the texts and chat are guaranteed a slot.
    expect(events.at(-1)).toEqual({ label: "Dashboard chat: 2 turns", href: "/dashboard/chat" });
    expect(events.at(-2)).toEqual({ label: "Texts: 4 received, 0 sent", href: "/dashboard/messages" });
  });

  it("reserves chat from the cap even when there are no texts", () => {
    const calls = Array.from({ length: DIGEST_EVENT_LINKS_MAX + 5 }, (_, i) => ({
      caller_e164: `+1555${String(i).padStart(7, "0")}`,
      status: "completed",
      started_at: "2026-06-11T10:00:00Z"
    }));
    const events = buildDigestEventLinks({ ...emptyActivity(), chatTurns: 1, calls });
    expect(events).toHaveLength(DIGEST_EVENT_LINKS_MAX);
    expect(events.at(-1)).toEqual({ label: "Dashboard chat: 1 turn", href: "/dashboard/chat" });
  });
});

describe("digest_builder isRenderableSmsSender", () => {
  it("accepts E.164 and 3-8 digit short codes, rejects everything else", () => {
    expect(isRenderableSmsSender("+14695555555")).toBe(true);
    expect(isRenderableSmsSender("73339")).toBe(true);
    expect(isRenderableSmsSender("123")).toBe(true);
    expect(isRenderableSmsSender("123456789")).toBe(false);
    expect(isRenderableSmsSender("notaphone")).toBe(false);
    expect(isRenderableSmsSender("")).toBe(false);
  });
});

describe("digest_builder smsCounterpartFromPayload", () => {
  function env(from: unknown) {
    return { data: { payload: { from } } };
  }

  it("reads from an object phone_number", () => {
    expect(smsCounterpartFromPayload(env({ phone_number: "+14695555555" }))).toBe("+14695555555");
  });

  it("reads a bare string sender (short code)", () => {
    expect(smsCounterpartFromPayload(env("73339"))).toBe("73339");
  });

  it("returns null for unrenderable, missing, or malformed shapes", () => {
    expect(smsCounterpartFromPayload(env({ phone_number: "garbage" }))).toBeNull();
    expect(smsCounterpartFromPayload(env("garbage"))).toBeNull();
    expect(smsCounterpartFromPayload(env(undefined))).toBeNull();
    expect(smsCounterpartFromPayload(env({}))).toBeNull();
    expect(smsCounterpartFromPayload({ data: {} })).toBeNull();
    expect(smsCounterpartFromPayload({})).toBeNull();
    expect(smsCounterpartFromPayload(null)).toBeNull();
    expect(smsCounterpartFromPayload("nope")).toBeNull();
  });
});

describe("digest_builder groupSmsThreads", () => {
  it("groups by counterpart, tallies direction, and sorts newest-thread first", () => {
    const threads = groupSmsThreads([
      { counterpart: "+1111", direction: "inbound", at: "2026-06-11T08:00:00Z" },
      { counterpart: "+1111", direction: "outbound", at: "2026-06-11T09:00:00Z" },
      { counterpart: "+2222", direction: "inbound", at: "2026-06-11T07:00:00Z" },
      { counterpart: "+1111", direction: "inbound", at: "2026-06-11T08:30:00Z" }
    ]);
    expect(threads).toEqual([
      { counterpart: "+1111", inbound: 2, outbound: 1, lastAt: "2026-06-11T09:00:00Z" },
      { counterpart: "+2222", inbound: 1, outbound: 0, lastAt: "2026-06-11T07:00:00Z" }
    ]);
  });

  it("keeps the earliest lastAt when later messages are older and handles empty input", () => {
    expect(groupSmsThreads([])).toEqual([]);
    const threads = groupSmsThreads([
      { counterpart: "+1", direction: "outbound", at: "2026-06-11T12:00:00Z" },
      { counterpart: "+1", direction: "inbound", at: "2026-06-11T06:00:00Z" }
    ]);
    expect(threads).toEqual([
      { counterpart: "+1", inbound: 1, outbound: 1, lastAt: "2026-06-11T12:00:00Z" }
    ]);
  });

  it("treats threads with identical lastAt as equal in the sort", () => {
    const threads = groupSmsThreads([
      { counterpart: "+1", direction: "inbound", at: "2026-06-11T10:00:00Z" },
      { counterpart: "+2", direction: "inbound", at: "2026-06-11T10:00:00Z" }
    ]);
    expect(threads).toEqual([
      { counterpart: "+1", inbound: 1, outbound: 0, lastAt: "2026-06-11T10:00:00Z" },
      { counterpart: "+2", inbound: 1, outbound: 0, lastAt: "2026-06-11T10:00:00Z" }
    ]);
  });

  it("reorders an earlier-seen thread below a later one (newest first)", () => {
    const threads = groupSmsThreads([
      { counterpart: "+1", direction: "inbound", at: "2026-06-11T08:00:00Z" },
      { counterpart: "+2", direction: "inbound", at: "2026-06-11T10:00:00Z" }
    ]);
    expect(threads).toEqual([
      { counterpart: "+2", inbound: 1, outbound: 0, lastAt: "2026-06-11T10:00:00Z" },
      { counterpart: "+1", inbound: 1, outbound: 0, lastAt: "2026-06-11T08:00:00Z" }
    ]);
  });
});
