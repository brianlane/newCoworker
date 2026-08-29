import { describe, expect, it } from "vitest";

/**
 * The fixed strings the Teams bot sends, and the prompt blocks it builds.
 *
 * Copy follows the OWNER's UI language choice, never Accept-Language, and
 * every table falls back to English rather than rendering `undefined` at
 * somebody. Several of these are the only thing an unrecognised account is
 * ever told, so a missing string is not cosmetic.
 */

import {
  TEAMS_REPLY_MAX_CHARS,
  TEAMS_SURFACE_BLOCK,
  TEAMS_TEAM_PREAMBLE,
  teamsNeedsLinkingMessage,
  teamsOnboardingMessage,
  teamsOverCapMessage,
  teamsTierBlockedMessage,
  teamsTurnFailedMessage
} from "@/lib/teams/chat";

const ALL = [
  teamsOnboardingMessage,
  teamsNeedsLinkingMessage,
  teamsOverCapMessage,
  teamsTierBlockedMessage,
  teamsTurnFailedMessage
];

describe("locale handling", () => {
  it("has a real string in every language it claims to support", () => {
    for (const fn of ALL) {
      expect(fn("en").length, fn.name).toBeGreaterThan(0);
      expect(fn("es").length, fn.name).toBeGreaterThan(0);
      expect(fn("es")).not.toBe(fn("en"));
    }
  });

  it("falls back to English for an absent or unknown locale", () => {
    for (const fn of ALL) {
      expect(fn()).toBe(fn("en"));
      expect(fn("de" as never)).toBe(fn("en"));
    }
  });
});

describe("the prompt blocks", () => {
  it("tells the model the speaker is already identified", () => {
    expect(TEAMS_SURFACE_BLOCK).toContain("never ask them to prove who they are");
    expect(TEAMS_SURFACE_BLOCK).toContain("never run the lead-intake script");
  });

  it("keeps the reply ceiling the prompt states in step with the constant", () => {
    expect(TEAMS_SURFACE_BLOCK).toContain(String(TEAMS_REPLY_MAX_CHARS));
  });

  it("withholds owner-only powers in the team persona, and says so", () => {
    expect(TEAMS_TEAM_PREAMBLE).toContain("NOT talking to the business owner");
    expect(TEAMS_TEAM_PREAMBLE).toContain("owner-only");
  });
});
