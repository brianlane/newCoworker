import { describe, expect, it } from "vitest";
import {
  assistantMessageInvitesReply,
  formatEmojiOnlyAnswerNote,
  isBareAcknowledgmentText,
  isEmojiOnlyText
} from "../supabase/functions/_shared/sms_ack";

/**
 * Bare-acknowledgment detection (sms_ack.ts): closing filler must match;
 * anything with real content must not. The production trigger: Truly
 * Insurance 2026-07-21, four consecutive "Ok"-shaped turns each drew a
 * fresh metered "Acknowledged!" reply.
 */
describe("isBareAcknowledgmentText", () => {
  it("matches the filler shapes from the live Truly thread", () => {
    for (const t of ["Ok", "ok", "Okay", "Okay 👍", "OK!", "Okay.", "Ok thanks", "Thanks!"]) {
      expect(isBareAcknowledgmentText(t), t).toBe(true);
    }
  });

  it("matches common closers, case- and punctuation-insensitively", () => {
    for (const t of [
      "sounds good",
      "Sounds good!",
      "Got it",
      "gotcha",
      "Thank you so much!!",
      "Perfect",
      "no worries",
      "Will do",
      "kk",
      "Alright",
      "Roger that."
    ]) {
      expect(isBareAcknowledgmentText(t), t).toBe(true);
    }
  });

  it("emoji-only inbounds are acks; bare punctuation is not", () => {
    expect(isBareAcknowledgmentText("👍")).toBe(true);
    expect(isBareAcknowledgmentText("🙏🙏")).toBe(true);
    // A bare "?" (or "??") is a nudge — the customer wants an answer.
    expect(isBareAcknowledgmentText("?")).toBe(false);
    expect(isBareAcknowledgmentText("??")).toBe(false);
    expect(isBareAcknowledgmentText("!!!")).toBe(false);
    expect(isBareAcknowledgmentText("👍?")).toBe(false);
  });

  it("a thumbs down is never an ack, whatever its skin tone or company", () => {
    // Swallowing a complaint is worse than answering one, and a thumbs down
    // beside an ack phrase ("Ok 👎") is a grudging yes that still deserves
    // an answer.
    for (const t of ["👎", "👎🏽", "👎👎", "👍👎", "Ok 👎", "Thanks 👎", "👎 will do"]) {
      expect(isBareAcknowledgmentText(t), t).toBe(false);
    }
  });

  it("never matches real content, questions, or numeric replies", () => {
    for (const t of [
      "Ok broker will call or I have to call?",
      "Ok 12pm wednesday is tomorrow",
      "Ok what time",
      "Thanks, can you resend the link?",
      "1", // claims a team offer
      "Ok 2", // picks a slot
      "Yes",
      "Sure",
      "Good",
      "Okey dokey artichokey",
      ""
    ]) {
      expect(isBareAcknowledgmentText(t), t).toBe(false);
    }
  });

  it("caps the length, a long message ending in thanks is a message", () => {
    expect(
      isBareAcknowledgmentText(
        "thanks thanks thanks thanks thanks thanks thanks thanks"
      )
    ).toBe(false);
  });
});

/**
 * Emoji-only replies get the guidance note when they land on a question the
 * assistant just asked: "🐬" answers nothing, and a model with no note picks
 * a reading and moves on.
 */
describe("isEmojiOnlyText", () => {
  it("matches emoji-only inbounds, whether or not they are acks", () => {
    for (const t of ["👍", "👎", "🐬", "🛎️", "🙂‍↕️", "🙏🙏", "  ❤️ "]) {
      expect(isEmojiOnlyText(t), t).toBe(true);
    }
  });

  it("strips the zero-width padding renderers add", () => {
    expect(isEmojiOnlyText("\u200B\u2764\uFE0F\u200B")).toBe(true);
  });

  it("never matches text, digits, bare punctuation, or long inbounds", () => {
    for (const t of ["Ok 👍", "👍 sounds good", "1️⃣", "?", "!!!", "", "   ", "😀".repeat(30)]) {
      expect(isEmojiOnlyText(t), t).toBe(false);
    }
  });
});

describe("formatEmojiOnlyAnswerNote", () => {
  it("quotes the emoji and tells the model to re-ask when it is unclear", () => {
    const note = formatEmojiOnlyAnswerNote("\u200B🐬\u200B");
    expect(note).toContain("🐬");
    expect(note).not.toContain("\u200B");
    expect(note).toContain("means no");
    expect(note).toContain("ask it again in plain words");
  });

  it("never writes an em dash (README writing rule)", () => {
    expect(formatEmojiOnlyAnswerNote("👎")).not.toContain("\u2014");
  });
});

describe("assistantMessageInvitesReply", () => {
  it("a trailing question mark invites a reply, through closers and emoji", () => {
    expect(assistantMessageInvitesReply("Does 2:00 PM Eastern work for you?")).toBe(true);
    expect(assistantMessageInvitesReply('…what day works best for you?"')).toBe(true);
    expect(assistantMessageInvitesReply("Do either of those work? 😊")).toBe(true);
    expect(assistantMessageInvitesReply("Ready to book?  ")).toBe(true);
  });

  it("statements do not", () => {
    expect(
      assistantMessageInvitesReply(
        "We're all set for your call with the broker tomorrow at 12:00 PM Eastern."
      )
    ).toBe(false);
    expect(assistantMessageInvitesReply("Got it, looking forward to it!")).toBe(false);
    expect(assistantMessageInvitesReply("")).toBe(false);
  });
});
