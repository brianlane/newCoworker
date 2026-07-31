/**
 * GET /.well-known/security.txt — RFC 9116 vulnerability disclosure pointer.
 */
import { describe, expect, it } from "vitest";

import { GET } from "@/app/.well-known/security.txt/route";

async function body(): Promise<string> {
  return await GET().text();
}

describe("GET /.well-known/security.txt", () => {
  it("serves plain text", async () => {
    const res = GET();
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("honours CONTACT_EMAIL, so it cannot disagree with the policy page", async () => {
    const previous = process.env.CONTACT_EMAIL;
    process.env.CONTACT_EMAIL = "security@example.test";
    try {
      expect(await body()).toContain("Contact: mailto:security@example.test");
    } finally {
      if (previous === undefined) delete process.env.CONTACT_EMAIL;
      else process.env.CONTACT_EMAIL = previous;
    }
  });

  it("carries the required RFC 9116 fields", async () => {
    const text = await body();
    expect(text).toContain("Contact: mailto:team@newcoworker.com");
    expect(text).toContain("Policy: https://www.newcoworker.com/security/vulnerability-disclosure");
    expect(text).toContain("Canonical: https://www.newcoworker.com/.well-known/security.txt");
    expect(text).toMatch(/^Expires: /m);
  });

  it("expires in the future, since a stale expiry reads as an abandoned policy", async () => {
    const text = await body();
    const expires = /^Expires: (.+)$/m.exec(text)?.[1];

    expect(expires).toBeDefined();
    expect(new Date(expires as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("ends with a newline so the last field parses", async () => {
    expect(await body()).toMatch(/\n$/);
  });
});
