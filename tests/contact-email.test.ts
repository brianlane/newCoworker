import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTACT_EMAIL, contactEmail } from "@/lib/marketing/contact-email";

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
const HOME = "src/lib/marketing/contact-email.ts";

/**
 * Doc comments may name the address when explaining the rule; what must not
 * reappear is a hardcoded address in CODE, which is how seven surfaces ended
 * up each carrying their own copy of the fallback and how security.txt
 * shipped disagreeing with the disclosure policy page it links to.
 */
function isComment(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield path;
  }
}

function offendersMatching(pattern: RegExp): string[] {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file);
    if (rel === HOME) continue;
    const text = readFileSync(file, "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (isComment(line)) continue;
      if (pattern.test(line)) offenders.push(`${rel}:${index + 1}`);
    }
  }
  return offenders;
}

describe("contactEmail", () => {
  const original = process.env.CONTACT_EMAIL;

  beforeEach(() => {
    delete process.env.CONTACT_EMAIL;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CONTACT_EMAIL;
    else process.env.CONTACT_EMAIL = original;
  });

  it("falls back to the address the deployment actually uses", () => {
    // The old per-file fallback said team@newcoworker.com while .env has set
    // CONTACT_EMAIL=contact@newcoworker.com all along, so every copy of the
    // fallback named an address the site does not use.
    expect(CONTACT_EMAIL).toBe("contact@newcoworker.com");
    expect(contactEmail()).toBe(CONTACT_EMAIL);
  });

  it("prefers the environment so staging can point elsewhere", () => {
    process.env.CONTACT_EMAIL = "staging@example.com";
    expect(contactEmail()).toBe("staging@example.com");
  });

  it("is the only place in src/ that hardcodes the contact address", () => {
    expect(
      offendersMatching(/contact@newcoworker\.com/),
      `Import contactEmail (or CONTACT_EMAIL) from @/lib/marketing/contact-email instead of hardcoding the address`
    ).toEqual([]);
  });

  it("is the only place in src/ that supplies a CONTACT_EMAIL fallback", () => {
    // A bare `process.env.CONTACT_EMAIL` read is still allowed: the mail
    // client uses one to mean "no Reply-To when unset", which is a different
    // decision from "what is our contact address". What is banned is the
    // `?? "..."` form, because that is a second home for the default.
    expect(
      offendersMatching(/process\.env\.CONTACT_EMAIL\s*\?\?/),
      `Call contactEmail() from @/lib/marketing/contact-email instead of re-declaring the fallback`
    ).toEqual([]);
  });

  it("does not claim the ops inbox, which is a different address", () => {
    // OPS_NOTIFICATION_EMAIL (team@newcoworker.com) has its own home in
    // src/lib/email/templates/ops-vps-deletion.ts. Guarding "team@" here
    // would fight that constant rather than protect this one.
    expect(CONTACT_EMAIL).not.toBe("team@newcoworker.com");
  });
});
