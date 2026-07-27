import { describe, expect, it } from "vitest";
import { buildRobotsTxt, ROBOTS_DISALLOW } from "@/lib/marketing/robots-txt";
import { GET } from "@/app/robots.txt/route";
import {
  AI_ANSWER_CRAWLER_TOKENS,
  AI_TRAINING_CRAWLER_TOKENS
} from "@/lib/marketing/ai-crawlers";
import { SITE_URL } from "@/lib/marketing/site-url";

const txt = buildRobotsTxt();

/** The rules that follow a `User-agent:` run, for the group containing `agent`. */
function groupFor(agent: string): string[] {
  const lines = txt.split("\n");
  const start = lines.findIndex((l) => l === `User-agent: ${agent}`);
  expect(start, `no group for ${agent}`).toBeGreaterThanOrEqual(0);
  const rules: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "") break;
    if (line.startsWith("User-agent:")) continue;
    rules.push(line);
  }
  return rules;
}

describe("robots.txt", () => {
  it("keeps the authenticated surfaces out of the wildcard group", () => {
    const rules = groupFor("*");
    expect(rules).toContain("Allow: /");
    for (const path of ROBOTS_DISALLOW) expect(rules).toContain(`Disallow: ${path}`);
  });

  it("declares the content signal the managed block used to carry", () => {
    expect(groupFor("*")).toContain("Content-Signal: search=yes,ai-input=yes,ai-train=no");
  });

  it("allows every answer engine, repeating the disallows", () => {
    // A crawler matching its own group ignores `*` entirely, so the
    // disallows have to be restated rather than inherited.
    for (const token of AI_ANSWER_CRAWLER_TOKENS) {
      const rules = groupFor(token === AI_ANSWER_CRAWLER_TOKENS[0] ? token : token);
      expect(rules).toContain("Allow: /");
      for (const path of ROBOTS_DISALLOW) expect(rules).toContain(`Disallow: ${path}`);
    }
  });

  it("disallows every training crawler outright", () => {
    for (const token of AI_TRAINING_CRAWLER_TOKENS) {
      expect(groupFor(token)).toEqual(["Disallow: /"]);
    }
  });

  it("never puts one agent in both groups", () => {
    // The whole failure this file exists to prevent: two contradicting
    // groups for one token, resolved differently by each crawler's parser.
    for (const token of AI_TRAINING_CRAWLER_TOKENS) {
      expect(AI_ANSWER_CRAWLER_TOKENS).not.toContain(token);
    }
  });

  it("advertises the sitemap on the canonical host", () => {
    expect(txt).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
    expect(txt).not.toContain("https://newcoworker.com/sitemap.xml");
  });

  it("points an editor at the source", () => {
    expect(txt).toContain("src/lib/marketing/robots-txt.ts");
  });
});

describe("the robots.txt route", () => {
  it("serves the built file as plain text", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(txt);
  });
});
