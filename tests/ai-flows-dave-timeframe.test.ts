import { describe, expect, it } from "vitest";
import {
  highestOptionDigit,
  timeframeOptionLine,
  addTimeframeOption,
  retroClaimOptionLine,
  addRetroClaimOption,
  stripLegacy86Line,
  addHomeLightEmailFallback,
  migrateEmailMatchToPrice
} from "../scripts/oneshot/update-dave-routed-aiflows";
import { parseAiFlowDefinition } from "../src/lib/ai-flows/schema";
import {
  parseClaimWithTimeframe,
  MAX_CLAIM_TIMEFRAME_LEN
} from "../supabase/functions/_shared/ai_flows/claim_timeframe";

describe("parseClaimWithTimeframe", () => {
  it("parses '<n>, <eta>' into digit + trimmed timeframe", () => {
    expect(parseClaimWithTimeframe("4, 20 min")).toEqual({ digit: "4", timeframe: "20 min" });
    expect(parseClaimWithTimeframe("3,a few days")).toEqual({ digit: "3", timeframe: "a few days" });
    expect(parseClaimWithTimeframe("  2 ,  2 hours  ")).toEqual({ digit: "2", timeframe: "2 hours" });
  });
  it("parses the late-claim '86, <eta>' shape", () => {
    expect(parseClaimWithTimeframe("86, tomorrow")).toEqual({ digit: "86", timeframe: "tomorrow" });
  });
  it("returns null for a bare digit (no comma'd ETA)", () => {
    expect(parseClaimWithTimeframe("2")).toBeNull();
    expect(parseClaimWithTimeframe("86")).toBeNull();
    expect(parseClaimWithTimeframe("4,")).toBeNull();
    expect(parseClaimWithTimeframe("4,   ")).toBeNull();
  });
  it("returns null for non-claim text", () => {
    expect(parseClaimWithTimeframe("STOP")).toBeNull();
    expect(parseClaimWithTimeframe("call me, please")).toBeNull();
  });
  it("caps an overlong timeframe to the shared max length", () => {
    const long = `5, ${"x".repeat(500)}`;
    const parsed = parseClaimWithTimeframe(long);
    expect(parsed?.timeframe.length).toBe(MAX_CLAIM_TIMEFRAME_LEN);
  });
});

describe("highestOptionDigit", () => {
  it("returns the highest single-digit option shown", () => {
    expect(highestOptionDigit("Reply 1 to claim or 2 to pass.")).toBe(2);
    expect(highestOptionDigit("Reply 1 to confirm.")).toBe(1);
  });
  it("ignores the 86 (reject) keyword when numbering", () => {
    expect(highestOptionDigit("Reply 1 or 2, or 86 to bail.")).toBe(2);
  });
  it("defaults to 1 when no option digits are present", () => {
    expect(highestOptionDigit("Take this lead by the deadline.")).toBe(1);
  });
});

describe("timeframeOptionLine", () => {
  it("renders the appended option with the given number", () => {
    expect(timeframeOptionLine(3)).toContain("Reply 3 with a timeframe to claim");
    expect(timeframeOptionLine(3)).toContain('"3, 20 min"');
  });
});

function daveRouteDef(offer: string) {
  return {
    version: 1 as const,
    trigger: { channel: "sms" as const, conditions: [{ type: "has_url" as const }] },
    steps: [
      {
        id: "route",
        type: "route_to_team",
        agentName: "Dave Lane",
        offerTemplate: offer,
        responseMinutes: 5,
        ownerFallbackTemplate: "No one claimed it — back to you."
      }
    ]
  };
}

describe("addTimeframeOption", () => {
  it("appends a timeframe option one greater than the last to a Dave-pinned route", () => {
    const def = daveRouteDef("New lead. Reply 1 to claim or 2 to pass by {{offer.deadline}}.");
    expect(addTimeframeOption(def, "Dave Lane")).toBe(true);
    const step = def.steps[0] as { offerTemplate: string; claimTimeframeOption?: number };
    expect(step.offerTemplate).toContain("Reply 3 with a timeframe to claim");
    // Stamps the digit so the engine treats "3, <eta>"/bare "3" as the accept
    // option (and never as a pass).
    expect(step.claimTimeframeOption).toBe(3);
    // Patched definition stays valid against the canonical schema.
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("is idempotent (no double-append on a second run)", () => {
    const def = daveRouteDef("Reply 1 to confirm by {{offer.deadline}}.");
    expect(addTimeframeOption(def, "Dave Lane")).toBe(true);
    const once = (def.steps[0] as { offerTemplate: string }).offerTemplate;
    expect(addTimeframeOption(def, "Dave Lane")).toBe(false);
    expect((def.steps[0] as { offerTemplate: string }).offerTemplate).toBe(once);
  });

  it("skips route steps pinned to a different agent or round-robin (no agentName)", () => {
    const other = daveRouteDef("Reply 1 to claim or 2 to pass.");
    (other.steps[0] as { agentName?: string }).agentName = "Someone Else";
    expect(addTimeframeOption(other, "Dave Lane")).toBe(false);

    const roundRobin = daveRouteDef("Reply 1 to claim or 2 to pass.");
    delete (roundRobin.steps[0] as { agentName?: string }).agentName;
    expect(addTimeframeOption(roundRobin, "Dave Lane")).toBe(false);
  });
});

describe("retroClaimOptionLine", () => {
  it("renders the appended retro option advertising only the comma/ETA form", () => {
    const line = retroClaimOptionLine(4);
    expect(line).toContain('Reply "4, <ETA>" to claim it after its window');
    expect(line).toContain("ETA of when you can please triple tap this lead?");
    expect(line).toContain('"4, tomorrow am"');
    // Never suggests a bare "Reply 4" that wouldn't re-open a lapsed lead.
    expect(line).not.toContain("Reply 4 to claim");
  });
});

describe("addRetroClaimOption", () => {
  it("appends the retro option at the next digit after the timeframe option and stamps lateClaimOption", () => {
    const def = daveRouteDef("New lead. Reply 1 to claim or 2 to pass by {{offer.deadline}}.");
    // Live timeframe option lands on 3; the retro option must follow on 4.
    expect(addTimeframeOption(def, "Dave Lane")).toBe(true);
    expect(addRetroClaimOption(def, "Dave Lane")).toBe(true);
    const step = def.steps[0] as {
      offerTemplate: string;
      claimTimeframeOption?: number;
      lateClaimOption?: number;
    };
    expect(step.claimTimeframeOption).toBe(3);
    expect(step.lateClaimOption).toBe(4);
    expect(step.offerTemplate).toContain('Reply "4, <ETA>" to claim it after its window');
    // The two option digits differ, so the patched definition stays valid.
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("is idempotent (no double-append on a second run)", () => {
    const def = daveRouteDef("Reply 1 to confirm by {{offer.deadline}}.");
    addTimeframeOption(def, "Dave Lane");
    expect(addRetroClaimOption(def, "Dave Lane")).toBe(true);
    const once = (def.steps[0] as { offerTemplate: string }).offerTemplate;
    expect(addRetroClaimOption(def, "Dave Lane")).toBe(false);
    expect((def.steps[0] as { offerTemplate: string }).offerTemplate).toBe(once);
  });

  it("skips a different agent or round-robin route step", () => {
    const other = daveRouteDef("Reply 1 to claim or 2 to pass.");
    (other.steps[0] as { agentName?: string }).agentName = "Someone Else";
    expect(addRetroClaimOption(other, "Dave Lane")).toBe(false);
  });
});

describe("stripLegacy86Line", () => {
  it("removes the legacy 'Reply 86 ... retroactively' line and keeps the rest", () => {
    const def = daveRouteDef(
      "New lead. Reply 1 to claim or 2 to pass by {{offer.deadline}}.\n" +
        "Missed the window? Reply 86 to still take it retroactively.\n" +
        'Reply 3 with a timeframe to claim (e.g. "3, 20 min").'
    );
    expect(stripLegacy86Line(def, "Dave Lane")).toBe(true);
    const offer = (def.steps[0] as { offerTemplate: string }).offerTemplate;
    expect(offer).not.toContain("Reply 86");
    expect(offer).toContain("Reply 1 to claim or 2 to pass");
    expect(offer).toContain("Reply 3 with a timeframe to claim");
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("is idempotent / no-op when there is no 86 line", () => {
    const def = daveRouteDef("Reply 1 to claim or 2 to pass by {{offer.deadline}}.");
    expect(stripLegacy86Line(def, "Dave Lane")).toBe(false);
  });

  it("skips a different agent", () => {
    const other = daveRouteDef("Reply 1.\nReply 86 to take it retroactively.");
    (other.steps[0] as { agentName?: string }).agentName = "Someone Else";
    expect(stripLegacy86Line(other, "Dave Lane")).toBe(false);
    expect((other.steps[0] as { offerTemplate: string }).offerTemplate).toContain("Reply 86");
  });
});

describe("addHomeLightEmailFallback", () => {
  const cfg = {
    connectionId: "9ddd5344-14f2-46df-a89d-dddc2d50e944",
    fromContains: "homelight.com",
    lookbackMinutes: 30
  };

  function homelightDef() {
    return {
      version: 1 as const,
      trigger: { channel: "sms" as const, conditions: [{ type: "has_url" as const }] },
      steps: [
        { id: "url", type: "extract_url", saveAs: "lead_url" },
        {
          id: "alert",
          type: "extract_text",
          fields: [{ name: "lead_first_name" }, { name: "price" }, { name: "city" }]
        },
        {
          id: "card",
          type: "browse_extract",
          urlVar: "lead_url",
          fields: [{ name: "lead_phone" }, { name: "lead_address" }]
        },
        {
          id: "route",
          type: "route_to_team",
          agentName: "Dave Lane",
          offerTemplate: "Reply 1 to claim by {{offer.deadline}}.",
          responseMinutes: 5,
          ownerFallbackTemplate: "Back to you."
        }
      ]
    };
  }

  it("inserts the email_card step right after the portal card and validates", () => {
    const def = homelightDef();
    expect(addHomeLightEmailFallback(def, cfg)).toBe(true);
    const ids = def.steps.map((s) => (s as { id: string }).id);
    expect(ids).toEqual(["url", "alert", "card", "email_card", "route"]);
    const inserted = def.steps[3] as unknown as {
      type: string;
      connectionId: string;
      matchTemplates?: string[];
      when?: unknown;
    };
    expect(inserted.type).toBe("email_extract");
    expect(inserted.connectionId).toBe(cfg.connectionId);
    expect(inserted.matchTemplates).toEqual([
      "{{vars.lead_first_name}}",
      "{{vars.price_digits}}"
    ]);
    expect(inserted.when).toEqual({ var: "claimed_agent", notEquals: "none" });
    // The match token must be produced by an earlier step: price_digits is added
    // to the alert extract right after `price`.
    const alertFields = (def.steps[1] as unknown as { fields: Array<{ name: string }> }).fields;
    expect(alertFields.map((f) => f.name)).toEqual([
      "lead_first_name",
      "price",
      "price_digits",
      "city"
    ]);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("validates an email_extract step that omits the optional matchTemplates", () => {
    const def = {
      version: 1 as const,
      trigger: { channel: "sms" as const, conditions: [{ type: "has_url" as const }] },
      steps: [
        {
          id: "email_card",
          type: "email_extract",
          connectionId: "9ddd5344-14f2-46df-a89d-dddc2d50e944",
          fields: [{ name: "lead_phone" }]
        }
      ]
    };
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("is idempotent and a no-op when there is no portal card step", () => {
    const def = homelightDef();
    expect(addHomeLightEmailFallback(def, cfg)).toBe(true);
    expect(addHomeLightEmailFallback(def, cfg)).toBe(false);

    const noCard = {
      version: 1 as const,
      trigger: { channel: "sms" as const, conditions: [{ type: "has_url" as const }] },
      steps: [{ id: "url", type: "extract_url", saveAs: "lead_url" }]
    };
    expect(addHomeLightEmailFallback(noCard, cfg)).toBe(false);
  });
});

describe("migrateEmailMatchToPrice", () => {
  // A live HomeLight flow whose email_card still matches on first name + city.
  function cityMatchedDef(alertFields: Array<{ name: string }>) {
    return {
      version: 1 as const,
      trigger: { channel: "sms" as const, conditions: [{ type: "has_url" as const }] },
      steps: [
        { id: "url", type: "extract_url", saveAs: "lead_url" },
        { id: "alert", type: "extract_text", fields: alertFields },
        {
          id: "card",
          type: "browse_extract",
          urlVar: "lead_url",
          fields: [{ name: "lead_phone" }, { name: "lead_address" }]
        },
        {
          id: "email_card",
          type: "email_extract",
          connectionId: "9ddd5344-14f2-46df-a89d-dddc2d50e944",
          fromContains: "homelight.com",
          matchTemplates: ["{{vars.lead_first_name}}", "{{vars.city}}"],
          fields: [{ name: "lead_phone" }, { name: "lead_address" }]
        },
        {
          id: "route",
          type: "route_to_team",
          agentName: "Dave Lane",
          offerTemplate: "Reply 1 to claim by {{offer.deadline}}.",
          responseMinutes: 5,
          ownerFallbackTemplate: "Back to you."
        }
      ]
    };
  }

  it("migrates city -> price and inserts price_digits after price", () => {
    const def = cityMatchedDef([
      { name: "lead_first_name" },
      { name: "price" },
      { name: "city" }
    ]);
    expect(migrateEmailMatchToPrice(def)).toBe(true);
    const emailCard = def.steps[3] as unknown as { matchTemplates: string[] };
    expect(emailCard.matchTemplates).toEqual([
      "{{vars.lead_first_name}}",
      "{{vars.price_digits}}"
    ]);
    const alertFields = (def.steps[1] as unknown as { fields: Array<{ name: string }> }).fields;
    expect(alertFields.map((f) => f.name)).toEqual([
      "lead_first_name",
      "price",
      "price_digits",
      "city"
    ]);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("appends price_digits when the alert has no price field", () => {
    const def = cityMatchedDef([{ name: "lead_first_name" }, { name: "city" }]);
    expect(migrateEmailMatchToPrice(def)).toBe(true);
    const alertFields = (def.steps[1] as unknown as { fields: Array<{ name: string }> }).fields;
    expect(alertFields.map((f) => f.name)).toEqual([
      "lead_first_name",
      "city",
      "price_digits"
    ]);
  });

  it("is idempotent once migrated", () => {
    const def = cityMatchedDef([
      { name: "lead_first_name" },
      { name: "price" },
      { name: "city" }
    ]);
    expect(migrateEmailMatchToPrice(def)).toBe(true);
    expect(migrateEmailMatchToPrice(def)).toBe(false);
  });

  it("no-ops when the flow has no email_card", () => {
    const def = {
      version: 1 as const,
      trigger: { channel: "sms" as const, conditions: [{ type: "has_url" as const }] },
      steps: [{ id: "url", type: "extract_url", saveAs: "lead_url" }]
    };
    expect(migrateEmailMatchToPrice(def)).toBe(false);
  });
});
