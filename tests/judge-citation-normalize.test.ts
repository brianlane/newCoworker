import { describe, expect, it } from "vitest";
import { normalizeForCitation } from "./e2e/judge";

/**
 * Pin the 2026-09-08 nightly companion failure: the live model wrapped
 * quoted SMS bodies in markdown italics, the judge copied the inner
 * phrase without the asterisks, and judgeReply then threw "cited text
 * absent from the reply" even though the citation was the same words.
 * Nightly run 34234123205, both in-test retries, pass 1.
 */
describe("normalizeForCitation", () => {
  it("grounds a citation that dropped markdown italics around quoted SMS", () => {
    const reply =
      'got it. looking at the thread with david tran (+15144967890): - on august 11, 2026, i texted: *"hey david, samantha here from kyp ads. want to grab a quick call this week?"* - david replied: *"maybe thursday"* - on august 13, 2026, i re-introduced myself from scratch: *"hi david, this is samantha with kyp ads! do you have time for a quick call this week?"*';
    const cited =
      'on august 11, 2026, i texted: "hey david, samantha here from kyp ads. want to grab a quick call this week?"';
    expect(normalizeForCitation(reply)).toContain(normalizeForCitation(cited));
  });

  it("grounds a numbered-list citation that dropped the same asterisks", () => {
    const reply =
      'got it. looking at david tran\'s thread (+15144967890), i see exactly what happened: 1. on august 11, 2026: sent *"hey david, samantha here from kyp ads. want to grab a quick call this week?"* 2. david replied: *"maybe thursday"* 3. on august 13, 2026: re-introduced as *"hi david, this is samantha with kyp ads! do you have time for a quick call this week?"* instead of following up on his mention of thursday.';
    const cited =
      'looking at david tran\'s thread (+15144967890), i see exactly what happened: 1. on august 11, 2026: sent "hey david, samantha here from kyp ads. want to grab a quick call this week?" 2. david replied: "maybe thursday" 3. on august 13, 2026: re-introduced as "hi david, this is samantha with kyp ads! do you have time for a quick call this week?" instead of following up on his mention of thursday.';
    expect(normalizeForCitation(reply)).toContain(normalizeForCitation(cited));
  });

  it("still rejects a citation that is not in the reply", () => {
    expect(
      normalizeForCitation('sent *"hey david, samantha here from kyp ads."*')
    ).not.toContain(normalizeForCitation("i will call you at 480 703 9575"));
  });
});
