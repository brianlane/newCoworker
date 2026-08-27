/**
 * Pins for the two Amy-side copy patches from the fleet fallback-composition
 * audit (Aug 27 2026): the Clever buyer whisper's price label
 * (patch-clever-accept-whisper-budget.ts) and the HomeLight team-copy fact
 * labels (patch-homelight-team-copy-labels.ts).
 *
 * Why the fixtures are byte-exact copies of the live phrases: both patches
 * match whole phrases and refuse drifted copy, so the tests are only honest
 * if they exercise the real wording. The Clever whisper fired at three
 * nesting depths and the HomeLight strings at nine sites; the fixtures mirror
 * that nesting, not just a flat list.
 *
 * The render assertions are the point of the whole exercise: with every var
 * at its written fallback, the patched copy must read as labelled facts
 * ("Phone: none"), never as the run-on that emailed Amy
 * "Lead: none ()  Address: Mesa" six times between Jul 31 and Aug 14 2026.
 */
import { describe, expect, it } from "vitest";

import {
  CLEVER_ACCEPT_FLOW_NAME,
  relabelWhisperBudget,
  WHISPER_PRICE_FIXED,
  WHISPER_PRICE_PRE_FIX
} from "../scripts/oneshot/patch-clever-accept-whisper-budget";
import {
  HOMELIGHT_COPY_FIXES,
  HOMELIGHT_FLOW_NAME,
  relabelTeamCopy
} from "../scripts/oneshot/patch-homelight-team-copy-labels";
import { renderTemplate } from "../supabase/functions/_shared/ai_flows/engine";

/** The whisper exactly as the live flow carried it on Aug 27 2026. */
const LIVE_WHISPER =
  "LIVE TRANSFER incoming, pick up!\n" +
  "Buyer {{vars.lead_name}} ({{vars.lead_phone}}) from Clever, looking around " +
  "{{vars.lead_address}} at about {{vars.price}}.\n" +
  "They are on the line now.";

/** Three sites at the live flow's real nesting depths. */
function cleverFixture(): Record<string, unknown> {
  const call = (id: string): Record<string, unknown> => ({
    id,
    type: "place_ai_call",
    toVar: "lead_phone",
    reachTeammate: { refs: ["gabrielle"], preSmsTemplate: LIVE_WHISPER }
  });
  return {
    steps: [
      {
        id: "s9",
        type: "branch",
        question: "Buyer?",
        branches: [
          {
            id: "s9b",
            label: "buyer",
            condition: { var: "lead_type", equals: "buyer" },
            steps: [call("buyer_call_1")]
          }
        ],
        else: []
      },
      {
        id: "s11",
        type: "branch",
        question: "Outcome?",
        branches: [
          {
            id: "s11b",
            label: "no answer",
            condition: { var: "call_outcome", equals: "no_answer" },
            steps: [
              {
                id: "retry",
                type: "branch",
                question: "Type?",
                branches: [
                  {
                    id: "retry_seller",
                    label: "seller",
                    condition: { var: "lead_type", equals: "seller" },
                    steps: []
                  }
                ],
                else: [call("buyer_call_2"), call("buyer_call_3")]
              }
            ]
          }
        ],
        else: []
      }
    ]
  };
}

describe("Clever buyer whisper budget label", () => {
  it("relabels all three whisper sites, wherever they nest", () => {
    const result = relabelWhisperBudget(cleverFixture());
    expect(result.changed).toBe(true);
    expect(result.notes.filter((n) => n.includes("labelled Budget"))).toHaveLength(3);
    const text = JSON.stringify(result.definition);
    expect(text).not.toContain("at about {{vars.price}}");
    expect(text.split("Budget: {{vars.price}}")).toHaveLength(4);
  });

  it("touches only preSmsTemplate, never a same-phrase body", () => {
    const fixture = {
      steps: [
        { id: "sms", type: "send_sms", to: "{{vars.lead_phone}}", body: LIVE_WHISPER },
        {
          id: "call",
          type: "place_ai_call",
          reachTeammate: { refs: ["dave"], preSmsTemplate: LIVE_WHISPER }
        }
      ]
    };
    const result = relabelWhisperBudget(fixture);
    const steps = result.definition.steps as Array<Record<string, unknown>>;
    expect(steps[0].body, "a body is not the whisper; leave it for its own review").toBe(
      LIVE_WHISPER
    );
    expect(
      (steps[1].reachTeammate as { preSmsTemplate: string }).preSmsTemplate
    ).toContain(WHISPER_PRICE_FIXED);
  });

  it("is idempotent and reports already patched on a second run", () => {
    const once = relabelWhisperBudget(cleverFixture());
    const twice = relabelWhisperBudget(once.definition);
    expect(twice.changed).toBe(false);
    expect(twice.notes.join("\n")).toContain("already patched");
    expect(twice.definition).toEqual(once.definition);
  });

  it("reports drifted copy instead of half-rewriting it", () => {
    const drifted = {
      steps: [
        {
          id: "call",
          type: "place_ai_call",
          reachTeammate: { refs: ["dave"], preSmsTemplate: "Buyer on the line at roughly {{vars.price}}." }
        }
      ]
    };
    const result = relabelWhisperBudget(drifted);
    expect(result.changed).toBe(false);
    expect(result.notes.join("\n")).toContain("resolve by hand");
  });

  it("reads as a fact when price fell back, and stays natural when known", () => {
    const patched = LIVE_WHISPER.split(WHISPER_PRICE_PRE_FIX).join(WHISPER_PRICE_FIXED);
    const fallback = renderTemplate(patched, {
      vars: { lead_name: "Sandy B.", lead_phone: "+15005550006", lead_address: "12 Oak St", price: "none" }
    });
    expect(fallback).toContain("looking around 12 Oak St. Budget: none.");
    expect(fallback).not.toMatch(/\bat about none\b/);
    const known = renderTemplate(patched, {
      vars: { lead_name: "Sandy B.", lead_phone: "+15005550006", lead_address: "12 Oak St", price: "$450,000" }
    });
    expect(known).toContain("Budget: $450,000.");
  });

  it("still targets the flow the audit named", () => {
    expect(CLEVER_ACCEPT_FLOW_NAME).toBe("Clever Lead - Accept");
  });
});

/** Every HomeLight site exactly as the live flow carried it on Aug 27 2026. */
function homelightFixture(): Record<string, unknown> {
  const releaseNote =
    "HomeLight just released the client's contact details: {{vars.lead_phone}} " +
    "{{vars.lead_email}}. Property address: {{vars.lead_address}}.";
  const assignedBody =
    "HomeLight lead assigned to you: {{vars.lead_name}} {{vars.lead_phone}} {{vars.lead_email}}\n" +
    "Address: {{vars.lead_address}}\nHomeLight claim call: {{vars.hl_call_outcome_label}}.\n" +
    "Portal: {{vars.leadUrl}}";
  const qtBody =
    "HomeLight referral assigned to {{vars.claimed_agent}}.\n" +
    "Lead: {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\n" +
    "Address: {{vars.lead_address}}\nLead source: HomeLight";
  const lateBody =
    "HomeLight just sent {{vars.lead_first_name}}'s contact info: {{vars.lead_name}} " +
    "{{vars.lead_phone}} {{vars.lead_email}}\nAddress: {{vars.lead_address}}";
  const revealMessage =
    "HomeLight just revealed {{vars.lead_first_name}}'s details: {{vars.lead_name}} " +
    "{{vars.lead_phone}} {{vars.lead_email}}\nAddress: {{vars.lead_address}}\n" +
    "Price: {{vars.email_price}}";
  return {
    steps: [
      { id: "brief1", type: "voice_brief", noteTemplate: releaseNote },
      { id: "brief2", type: "voice_brief", noteTemplate: releaseNote },
      {
        id: "claimed",
        type: "branch",
        question: "Claimed?",
        branches: [
          {
            id: "claimed_yes",
            label: "claimed",
            condition: { var: "already_claimed", notEquals: "yes" },
            steps: [
              { id: "assign_sms", type: "send_sms", to: "{{vars.claimed_agent_phone}}", body: assignedBody },
              {
                id: "qt_email",
                type: "send_email",
                to: "amy@example.com",
                subject: "{{vars.lead_name}} QT HL CC DAVE",
                body: qtBody
              }
            ]
          }
        ],
        else: [
          { id: "late1", type: "send_sms", to: "{{vars.claimed_agent_phone}}", body: lateBody },
          { id: "late2", type: "send_sms", to: "{{vars.claimed_agent_phone}}", body: lateBody },
          { id: "reveal1", type: "notify_lead_owner", message: revealMessage },
          { id: "reveal2", type: "notify_lead_owner", message: revealMessage },
          { id: "reveal3", type: "notify_lead_owner", message: revealMessage }
        ]
      }
    ]
  };
}

describe("HomeLight team copy fact labels", () => {
  const FALLBACK_SCOPE = {
    vars: {
      lead_name: "none",
      lead_first_name: "",
      lead_phone: "none",
      lead_email: "none",
      lead_address: "none",
      claimed_agent: "Gabrielle Mota",
      claimed_agent_phone: "+15005550006",
      hl_call_outcome_label: "no call came in",
      leadUrl: "https://portal.example.com/r/1",
      email_price: "none"
    }
  };

  it("patches every site at its expected count", () => {
    const result = relabelTeamCopy(homelightFixture());
    expect(result.changed).toBe(true);
    expect(
      result.notes.filter((n) => n.includes("drifted")),
      "every site matches, so no drift warnings"
    ).toEqual([]);
    const text = JSON.stringify(result.definition);
    for (const fix of HOMELIGHT_COPY_FIXES) {
      expect(text, fix.label).not.toContain(JSON.stringify(fix.old).slice(1, -1));
    }
  });

  it("renders labelled facts, never the none-run-on, when everything fell back", () => {
    const result = relabelTeamCopy(homelightFixture());
    const strings: string[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (typeof v === "string" && ["noteTemplate", "body", "message"].includes(k)) strings.push(v);
        else visit(v);
      }
    };
    visit(result.definition);
    expect(strings.length).toBeGreaterThanOrEqual(9);
    for (const template of strings) {
      const rendered = renderTemplate(template, FALLBACK_SCOPE);
      expect(rendered, template.slice(0, 40)).not.toMatch(/\bnone none\b/);
      expect(rendered).not.toContain("just sent's");
    }
    const claim = renderTemplate(
      (result.definition.steps as Array<Record<string, unknown>>)
        .map((s) => JSON.stringify(s))
        .join(""),
      FALLBACK_SCOPE
    );
    expect(claim).toContain("Phone: none. Email: none");
    expect(claim).toContain("phone none, email none");
  });

  it("leaves the filter-bearing QT subject exactly alone", () => {
    const result = relabelTeamCopy(homelightFixture());
    const text = JSON.stringify(result.definition);
    expect(text).toContain("{{vars.lead_name}} QT HL CC DAVE");
  });

  it("is idempotent and reports already patched on a second run", () => {
    const once = relabelTeamCopy(homelightFixture());
    const twice = relabelTeamCopy(once.definition);
    expect(twice.changed).toBe(false);
    expect(twice.notes.join("\n")).toContain("already patched");
    expect(twice.definition).toEqual(once.definition);
  });

  it("warns when a site count is off instead of pretending completeness", () => {
    const fixture = homelightFixture();
    (fixture.steps as Array<Record<string, unknown>>).splice(1, 1); // drop brief2
    const result = relabelTeamCopy(fixture);
    expect(result.changed).toBe(true);
    expect(result.notes.join("\n")).toContain("voice_brief release notes: found 1 site(s), expected 2");
  });

  it("reports a fully drifted flow instead of writing nothing silently", () => {
    const result = relabelTeamCopy({ steps: [{ id: "x", type: "send_sms", body: "Hi there" }] });
    expect(result.changed).toBe(false);
    expect(result.notes.join("\n")).toContain("resolve by hand");
  });

  it("still targets the flow the audit named", () => {
    expect(HOMELIGHT_FLOW_NAME).toBe("HomeLight Referral");
  });
});
