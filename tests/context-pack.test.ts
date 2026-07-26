import { describe, expect, it } from "vitest";
import {
  escapeTableCell,
  extractPrNumbers,
  extractReadmeSections,
  extractUserQuery,
  headingAnchor,
  isoDaysAgo,
  oneLine,
  parseContextPackArgs,
  redactIdentifiers,
  stripRitualPrefixes
} from "../scripts/context-pack";

/**
 * Unit coverage for the pure text helpers behind `scripts/context-pack.ts`.
 *
 * The generator's IO (git, gh, Supabase, the transcript archive) is
 * environment-dependent and deliberately untested here; what matters and what
 * can silently rot is the text handling, above all the two rules that keep the
 * pack safe and readable: end-user identifiers never reach the file, and the
 * repeated session preamble is removed BEFORE anything gets truncated.
 *
 * `scripts/**` is outside the coverage `include`, so this file adds assertions
 * without moving the 100% thresholds.
 */

describe("parseContextPackArgs", () => {
  it("defaults to a 14-day window writing docs/CONTEXT-PACK.md with the fleet section", () => {
    expect(parseContextPackArgs([])).toEqual({ days: 14, out: "docs/CONTEXT-PACK.md", fleet: true });
  });

  it("reads the window, the output target, and the fleet opt-out", () => {
    expect(parseContextPackArgs(["--days", "30", "--out", "-", "--no-fleet"])).toEqual({
      days: 30,
      out: "-",
      fleet: false
    });
  });

  it("falls back to 14 days when --days is not a number", () => {
    expect(parseContextPackArgs(["--days", "soon"]).days).toBe(14);
  });
});

describe("redactIdentifiers", () => {
  it("removes emails and phone numbers in the shapes people actually type", () => {
    const redacted = redactIdentifiers("call +14805551234 or (480) 555-1234 or 480.555.1234, email jo@example.com");
    expect(redacted).not.toMatch(/4805551234|555-1234|555\.1234/);
    expect(redacted).not.toContain("jo@example.com");
    expect(redacted).toContain("<phone>");
    expect(redacted).toContain("<email>");
  });

  it("leaves bare digit runs alone so migration stamps stay readable", () => {
    // The whole repo talks in stamps like 20260805000600; redacting them made
    // the digest unreadable while protecting nothing.
    expect(redactIdentifiers("restamped to 20260805000600 above the head")).toContain("20260805000600");
  });
});

describe("stripRitualPrefixes", () => {
  const ritual = "read the readme and review the application code.";
  const alsoRitual = "Then review the past conversations from the last two weeks.";

  it("drops leading sentences that recur across the batch", () => {
    const asks = [
      `${ritual} ${alsoRitual} Why did Dave get stored as a customer?`,
      `${ritual} ${alsoRitual} Investigate the KYP booking page.`,
      `${ritual} ${alsoRitual} Is the daily digest running?`,
      `${ritual} ${alsoRitual} Fix the mobile layout.`,
      `${ritual} ${alsoRitual} Audit our GitHub security.`
    ];
    expect(stripRitualPrefixes(asks)).toEqual([
      "Why did Dave get stored as a customer?",
      "Investigate the KYP booking page.",
      "Is the daily digest running?",
      "Fix the mobile layout.",
      "Audit our GitHub security."
    ]);
  });

  it("keeps a one-off opening sentence that no other session shares", () => {
    const asks = [
      "Hold my hand on this one. I am editing an AiFlow.",
      `${ritual} Fix the stats.`,
      `${ritual} Fix the spacing.`,
      `${ritual} Fix the sidebar.`
    ];
    expect(stripRitualPrefixes(asks)[0]).toBe("Hold my hand on this one. I am editing an AiFlow.");
  });

  it("never strips an ask down to nothing", () => {
    const asks = [ritual, ritual, ritual, ritual, ritual];
    for (const stripped of stripRitualPrefixes(asks)) expect(stripped).toBe(ritual);
  });
});

describe("extractUserQuery", () => {
  it("unwraps the harness tags and returns the query untruncated", () => {
    const long = "x".repeat(400);
    const wrapped = `<timestamp>Sunday</timestamp>\n<user_query>\n${long}\n</user_query>`;
    expect(extractUserQuery(wrapped)).toBe(long);
  });

  it("falls back to the raw text when there is no user_query tag", () => {
    expect(extractUserQuery("just a question")).toBe("just a question");
  });
});

describe("extractPrNumbers", () => {
  it("collects unique PR numbers from full pull URLs, sorted", () => {
    const transcript = [
      "merged https://github.com/brianlane/newCoworker/pull/939",
      "see https://github.com/brianlane/newCoworker/pull/934 and /pull/939 again",
      "https://github.com/brianlane/newCoworker/pull/934"
    ].join("\n");
    expect(extractPrNumbers(transcript)).toEqual([934, 939]);
  });

  it("ignores bare hash references, which are ambiguous", () => {
    expect(extractPrNumbers("fixed in #942 per the issue tracker")).toEqual([]);
  });
});

describe("extractReadmeSections", () => {
  it("indexes level-two headings with their line numbers", () => {
    const readme = ["# Title", "", "## Pricing", "text", "## Testing", ""].join("\n");
    expect(extractReadmeSections(readme)).toEqual([
      { title: "Pricing", line: 3 },
      { title: "Testing", line: 5 }
    ]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const readme = ["## Real", "```bash", "## not a heading", "```", "## Also real"].join("\n");
    expect(extractReadmeSections(readme).map((s) => s.title)).toEqual(["Real", "Also real"]);
  });
});

describe("headingAnchor", () => {
  it("matches GitHub's slug for headings carrying punctuation", () => {
    expect(headingAnchor("Memory knowledge graph (shadow rollout, Jul 2026)")).toBe(
      "memory-knowledge-graph-shadow-rollout-jul-2026"
    );
  });
});

describe("escapeTableCell", () => {
  it("escapes pipes so a title cannot split the table", () => {
    expect(escapeTableCell("Fix a|b routing")).toBe("Fix a\\|b routing");
  });

  it("escapes backslashes first, so a trailing backslash cannot free the pipe", () => {
    // "a\" + "|" naively becomes "a\\|", where the original backslash escapes
    // the added one and the pipe splits the cell anyway.
    expect(escapeTableCell("a\\|b")).toBe("a\\\\\\|b");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeTableCell("Booking confirmations and reminders")).toBe("Booking confirmations and reminders");
  });
});

describe("oneLine", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(oneLine("a\n  b\tc", 100)).toBe("a b c");
    expect(oneLine("abcdef", 4)).toBe("abc…");
  });
});

describe("isoDaysAgo", () => {
  it("returns the calendar date the given number of days before now", () => {
    expect(isoDaysAgo(14, new Date("2026-07-26T12:00:00Z"))).toBe("2026-07-12");
  });
});
