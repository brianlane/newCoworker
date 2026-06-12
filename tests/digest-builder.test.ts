import { describe, expect, it } from "vitest";
import {
  AI_FLOW_RECAP_MAX_RUNS,
  buildAiFlowRecapLine,
  buildDigestEmailModel,
  hasDigestActivity,
  routingSummary,
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
    expect(buildAiFlowRecapLine(makeRun())).toBe("Lead intake — done");
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
      "Lead intake — done · offered to 1 agent · claimed by Gabrielle · " +
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
    expect(line).toBe("Lead intake — done · lead: Alias Name, e@x.com");
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
    ).toBe("Lead intake — done");
    expect(
      buildAiFlowRecapLine(makeRun({ context: { vars: { actions_taken: 42 } } }))
    ).toBe("Lead intake — done");
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

    expect(model.subject).toBe("Daily summary — Acme Plumbing (11 events)");
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
      "+15550001111 — completed",
      "unknown caller — errored"
    ]);
    expect(model.sections[2].lines).toEqual(["Lead intake — done"]);
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
    expect(model.subject).toBe("Weekly summary — Acme (2 events)");
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
