import { describe, expect, it } from "vitest";
import { buildOwnerSurfaceSystem } from "@/lib/owner-surfaces/system";
import { OWNER_TURN_SURFACES, ownerTurnSurface } from "@/lib/owner-surfaces/turn-surfaces";
import { ownerSurfaceByKey } from "@/lib/owner-surfaces/registry";
import {
  EMAIL_TOOL_DISABLED_PREAMBLE,
  EMAIL_TOOL_ENABLED_PREAMBLE,
  OWNER_PREAMBLE
} from "@/lib/owner-surfaces/preambles";
import type { SurfaceSpeaker } from "@/lib/owner-surfaces/speaker";

/**
 * The per-turn system instruction, assembled once for every surface.
 *
 * owner-sms-turn and slack/worker built this list separately, in the same
 * order, from the same parts. The order is not cosmetic: OWNER_PREAMBLE is
 * pinned first so the very first thing the model reads is "you are the
 * owner's assistant" rather than the customer intake persona it defaults
 * to.
 */

const OWNER: SurfaceSpeaker = { kind: "owner", name: "James Fung", readFailed: false };
const TEAMMATE: SurfaceSpeaker = { kind: "teammate", name: "Dana Ruiz", readFailed: false };

function build(overrides: Partial<Parameters<typeof buildOwnerSurfaceSystem>[0]> = {}) {
  return buildOwnerSurfaceSystem({
    surface: ownerTurnSurface("whatsapp"),
    speaker: OWNER,
    speakerRef: "+15145188192",
    emailToolEnabled: true,
    timezone: "America/Toronto",
    bridgeToolsDeclared: false,
    now: new Date("2026-08-25T18:00:00Z"),
    ...overrides
  });
}

describe("every turn surface is a registered surface", () => {
  it("has a registry entry behind it", () => {
    for (const surface of Object.values(OWNER_TURN_SURFACES)) {
      expect(ownerSurfaceByKey(surface.key), surface.key).not.toBeNull();
    }
  });

  it("agrees with the registry about its flow-edit source", () => {
    for (const surface of Object.values(OWNER_TURN_SURFACES)) {
      expect(surface.flowEditSource, surface.key).toBe(
        ownerSurfaceByKey(surface.key)?.flowEditSource
      );
    }
  });

  it("declares a team preamble exactly when it serves teammates", () => {
    // A surface that admits teammates without a persona for them would fall
    // back to OWNER MODE, which is how a teammate gets owner powers.
    for (const surface of Object.values(OWNER_TURN_SURFACES)) {
      expect(Boolean(surface.teamPreamble), surface.key).toBe(
        surface.serves.includes("teammate")
      );
    }
  });

  it("throws for a surface that does not run owner turns", () => {
    expect(() => ownerTurnSurface("email" as never)).toThrow(/email/);
  });
});

describe("buildOwnerSurfaceSystem, persona", () => {
  it("pins OWNER_PREAMBLE first for an owner", () => {
    expect(build().startsWith(OWNER_PREAMBLE)).toBe(true);
  });

  it("uses the surface's team preamble for a teammate, never OWNER MODE", () => {
    const system = build({ speaker: TEAMMATE });
    expect(system).not.toContain(OWNER_PREAMBLE);
    expect(system.startsWith(ownerTurnSurface("whatsapp").teamPreamble!)).toBe(true);
  });

  it("puts the surface block second and the speaker line third", () => {
    const surface = ownerTurnSurface("whatsapp");
    const blocks = build().split("\n\n");
    expect(build()).toContain(surface.surfaceBlock);
    expect(blocks.indexOf(surface.surfaceBlock.split("\n\n")[0])).toBeGreaterThan(-1);
    expect(build()).toContain(surface.speakerLine(OWNER, "+15145188192"));
  });

  it("names the speaker so the model does not ask them to prove who they are", () => {
    expect(build()).toContain("James Fung");
    expect(build({ speaker: TEAMMATE })).toContain("Dana Ruiz");
  });
});

describe("buildOwnerSurfaceSystem, email protocol", () => {
  it("teaches the EMAIL_SEND protocol to an owner whose tool is on", () => {
    expect(build()).toContain(EMAIL_TOOL_ENABLED_PREAMBLE);
  });

  it("uses the disabled twin when the tool is off, never silence", () => {
    // The disabled twin is equally load-bearing: without it the model
    // invents tool-call syntax and claims the mail went out.
    const system = build({ emailToolEnabled: false });
    expect(system).toContain(EMAIL_TOOL_DISABLED_PREAMBLE);
    expect(system).not.toContain(EMAIL_TOOL_ENABLED_PREAMBLE);
  });

  it("gives a teammate neither, because email is owner-only here", () => {
    const system = build({ speaker: TEAMMATE });
    expect(system).not.toContain(EMAIL_TOOL_ENABLED_PREAMBLE);
    expect(system).not.toContain(EMAIL_TOOL_DISABLED_PREAMBLE);
  });
});

describe("buildOwnerSurfaceSystem, optional blocks", () => {
  it("omits every optional block cleanly rather than leaving blank gaps", () => {
    const system = build();
    expect(system).not.toMatch(/\n{3,}/);
  });

  it("includes the grounding blocks in order when present", () => {
    const system = build({
      integrationsLine: "CONNECTED INTEGRATIONS: calendar",
      bookingLinkLine: "Booking page: https://example.test/book",
      businessContextBlock: "YOUR BUSINESS CONFIGURATION"
    });
    const at = (s: string) => system.indexOf(s);
    expect(at("CONNECTED INTEGRATIONS: calendar")).toBeGreaterThan(-1);
    expect(at("Booking page: https://example.test/book")).toBeGreaterThan(
      at("CONNECTED INTEGRATIONS: calendar")
    );
    expect(at("YOUR BUSINESS CONFIGURATION")).toBeGreaterThan(
      at("Booking page: https://example.test/book")
    );
  });

  it("carries the current date in the business timezone", () => {
    expect(build()).toMatch(/2026/);
  });

  it("adds the bridge preamble only when bridged tools are declared", () => {
    expect(build({ bridgeToolsDeclared: true })).toMatch(/create_aiflow|connected app|MCP|tools/i);
    const without = build({ bridgeToolsDeclared: false });
    const with_ = build({ bridgeToolsDeclared: true });
    expect(with_.length).toBeGreaterThan(without.length);
  });

  it("labels the transcript with the surface's own wording", () => {
    const system = build({ transcript: "[Owner]: hi\n[Coworker]: hello" });
    expect(system).toContain(ownerTurnSurface("whatsapp").transcriptLabel);
    expect(system).toContain("[Owner]: hi");
  });

  it("omits the transcript block entirely when there is nothing to replay", () => {
    expect(build({ transcript: "" })).not.toContain(
      ownerTurnSurface("whatsapp").transcriptLabel
    );
    expect(build({ transcript: null })).not.toContain(
      ownerTurnSurface("whatsapp").transcriptLabel
    );
  });
});

describe("buildOwnerSurfaceSystem, per surface", () => {
  it("reproduces the owner-SMS block order the route already used", () => {
    const system = buildOwnerSurfaceSystem({
      surface: ownerTurnSurface("sms"),
      speaker: OWNER,
      speakerRef: "+15145188192",
      emailToolEnabled: true,
      timezone: null,
      bridgeToolsDeclared: false,
      now: new Date("2026-08-25T18:00:00Z")
    });
    const blocks = system.split("\n\n");
    expect(blocks[0]).toBe(OWNER_PREAMBLE.split("\n\n")[0]);
    expect(system).toContain("THIS CONVERSATION IS OVER SMS");
    expect(system).toContain("texting from +15145188192");
  });

  it("tells the WhatsApp surface it is WhatsApp", () => {
    expect(build()).toContain("WHATSAPP");
  });
});

describe("buildOwnerSurfaceSystem, surfaces that serve owners only", () => {
  it("refuses to build a teammate turn for an owner-only surface", () => {
    // Rather than emitting a prompt with no persona block, which the model
    // would fill in with its customer intake default.
    expect(() =>
      buildOwnerSurfaceSystem({
        surface: ownerTurnSurface("sms"),
        speaker: TEAMMATE,
        speakerRef: "+15145550100",
        emailToolEnabled: true,
        timezone: null,
        bridgeToolsDeclared: false
      })
    ).toThrow(/sms serves owners only/);
  });

  it("defaults the clock to now when the caller does not pin one", () => {
    const system = buildOwnerSurfaceSystem({
      surface: ownerTurnSurface("sms"),
      speaker: OWNER,
      speakerRef: "+15145188192",
      emailToolEnabled: true,
      timezone: null,
      bridgeToolsDeclared: false
    });
    expect(system).toContain(String(new Date().getUTCFullYear()));
  });
});

describe("speaker lines, per surface", () => {
  const anonOwner: SurfaceSpeaker = { kind: "owner", name: null, readFailed: false };
  const anonMate: SurfaceSpeaker = { kind: "teammate", name: null, readFailed: false };

  it("names the owner on SMS, and copes when no name is known", () => {
    const sms = ownerTurnSurface("sms");
    expect(sms.speakerLine(OWNER, "+1514")).toBe(
      "The texter is the business OWNER, James Fung, texting from +1514."
    );
    expect(sms.speakerLine(anonOwner, "+1514")).toBe(
      "The texter is the business OWNER, texting from +1514."
    );
  });

  it("distinguishes owner from team member in Slack", () => {
    const slack = ownerTurnSurface("slack");
    expect(slack.speakerLine(OWNER, "@james")).toContain("business OWNER, James Fung");
    expect(slack.speakerLine(anonOwner, "@james")).toContain("the business OWNER,");
    expect(slack.speakerLine(TEAMMATE, "@dana")).toBe(
      "The speaker is team member @dana in the business's Slack workspace."
    );
  });

  it("distinguishes owner from team member on WhatsApp", () => {
    const wa = ownerTurnSurface("whatsapp");
    expect(wa.speakerLine(OWNER, "+1514")).toContain("business OWNER, James Fung");
    expect(wa.speakerLine(anonOwner, "+1514")).toContain("the business OWNER, from");
    expect(wa.speakerLine(TEAMMATE, "+1514")).toContain("Dana Ruiz");
    expect(wa.speakerLine(anonMate, "+1514")).toContain("a team member");
  });
});
