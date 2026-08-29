import { describe, expect, it } from "vitest";

/**
 * The fixed strings the Google Chat app sends, and the prompt blocks it
 * builds.
 *
 * Copy follows the OWNER's UI language choice, never Accept-Language, and
 * every table falls back to English rather than rendering `undefined` at
 * somebody. Several of these are the only thing an unrecognised account or
 * an unconnected space is ever told, so a missing string is not cosmetic.
 */

import {
  GOOGLE_CHAT_REPLY_MAX_CHARS,
  GOOGLE_CHAT_SURFACE_BLOCK,
  GOOGLE_CHAT_TEAM_PREAMBLE,
  googleChatAlreadyBoundMessage,
  googleChatBindFailedMessage,
  googleChatLinkRejectedMessage,
  googleChatNeedsLinkingMessage,
  googleChatOnboardingMessage,
  googleChatOverCapMessage,
  googleChatTierBlockedMessage,
  googleChatTurnFailedMessage,
  googleChatUnboundSpaceMessage
} from "@/lib/google-chat/chat";

const ALL = [
  googleChatOnboardingMessage,
  googleChatUnboundSpaceMessage,
  googleChatNeedsLinkingMessage,
  googleChatAlreadyBoundMessage,
  googleChatBindFailedMessage,
  googleChatLinkRejectedMessage,
  googleChatOverCapMessage,
  googleChatTierBlockedMessage,
  googleChatTurnFailedMessage
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

describe("the two different 'I cannot help you' messages", () => {
  it("names no business in the UNBOUND-space one", () => {
    // At that point we do not know of one, and could not name it safely if
    // we did: our Chat app can be added to any space in any Workspace that
    // can find it, so this is the reply to a complete stranger.
    const text = googleChatUnboundSpaceMessage();
    expect(text).toContain("connect code");
    expect(text).toContain("Integrations");
  });

  it("asks for a code for the PERSON in the connected-space one", () => {
    // Different problem, different fix. Here the business is known and the
    // space is bound; it is the speaker the roster cannot place.
    const text = googleChatNeedsLinkingMessage();
    expect(text).toContain("your Google Chat account");
  });

  it("tells somebody spending a code in a second space how to move it", () => {
    expect(googleChatAlreadyBoundMessage()).toContain("disconnect");
  });

  it("says the code is gone in BOTH messages that are sent after it is spent", () => {
    // A code is single use, and which business it belongs to is only
    // knowable by redeeming it, so neither of these outcomes could have
    // been checked first. Not saying so sends the owner back to a space
    // with a code that will be refused.
    for (const fn of [googleChatAlreadyBoundMessage, googleChatBindFailedMessage]) {
      expect(fn("en"), fn.name).toContain("used up");
      expect(fn("es"), fn.name).toContain("gastado");
    }
  });
});

describe("the prompt blocks", () => {
  it("tells the model the speaker is already identified", () => {
    expect(GOOGLE_CHAT_SURFACE_BLOCK).toContain("never ask them to prove who they are");
    expect(GOOGLE_CHAT_SURFACE_BLOCK).toContain("never run the lead-intake script");
  });

  it("names Chat's OWN bold syntax, not markdown's", () => {
    // Chat renders *bold* with single asterisks and has no headings or
    // tables. Telling the model to use markdown here produces literal
    // asterisks and pipes in the tenant's space.
    expect(GOOGLE_CHAT_SURFACE_BLOCK).toContain("single asterisks");
    expect(GOOGLE_CHAT_SURFACE_BLOCK).toContain("No markdown headings");
  });

  it("keeps the reply ceiling the prompt states in step with the constant", () => {
    expect(GOOGLE_CHAT_SURFACE_BLOCK).toContain(String(GOOGLE_CHAT_REPLY_MAX_CHARS));
  });

  it("withholds owner-only powers in the team persona, and says so", () => {
    expect(GOOGLE_CHAT_TEAM_PREAMBLE).toContain("NOT talking to the business owner");
    expect(GOOGLE_CHAT_TEAM_PREAMBLE).toContain("owner-only");
  });
});
