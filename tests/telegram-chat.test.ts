import { describe, expect, it } from "vitest";

/**
 * The fixed strings the Telegram bot sends.
 *
 * Copy follows the OWNER's UI language choice, never Accept-Language, and
 * every table falls back to English rather than rendering `undefined` at
 * somebody. A missing string on this surface is not cosmetic: several of
 * these are the only thing an unrecognised account is ever told.
 */

import {
  TELEGRAM_REPLY_MAX_CHARS,
  TELEGRAM_SURFACE_BLOCK,
  TELEGRAM_TEAM_PREAMBLE,
  telegramContactNotYoursMessage,
  telegramLinkAcceptedMessage,
  telegramLinkRejectedMessage,
  telegramNeedsLinkingMessage,
  telegramOnboardingMessage,
  telegramOverCapMessage,
  telegramShareContactButton,
  telegramTierBlockedMessage,
  telegramTurnFailedMessage
} from "@/lib/telegram/chat";

const ALL = [
  telegramOnboardingMessage,
  telegramNeedsLinkingMessage,
  telegramLinkAcceptedMessage,
  telegramLinkRejectedMessage,
  telegramShareContactButton,
  telegramContactNotYoursMessage,
  telegramOverCapMessage,
  telegramTierBlockedMessage,
  telegramTurnFailedMessage
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
    // Asking a teammate to prove who they are on a surface only connected
    // accounts can reach is the exact failure the identity work prevents.
    expect(TELEGRAM_SURFACE_BLOCK).toContain("never ask them to prove who they are");
    expect(TELEGRAM_SURFACE_BLOCK).toContain("never run the lead-intake script");
  });

  it("keeps the reply ceiling the prompt states in step with the constant", () => {
    expect(TELEGRAM_SURFACE_BLOCK).toContain(String(TELEGRAM_REPLY_MAX_CHARS));
  });

  it("withholds owner-only powers in the team persona, and says so", () => {
    expect(TELEGRAM_TEAM_PREAMBLE).toContain("NOT talking to the business owner");
    expect(TELEGRAM_TEAM_PREAMBLE).toContain("owner-only");
  });
});
