import { describe, expect, it } from "vitest";
import {
  GOOGLE_VERIFIED_SCOPES,
  GOOGLE_WORKSPACE_SCOPES,
  googleGrantCovers,
  googleWorkspaceScopeParam
} from "@/lib/google/workspace-scopes";

/**
 * The frozen set, written out literally rather than imported, so this test
 * compares two independent statements of the truth. Importing the constant and
 * asserting it equals itself would pass through any edit.
 */
const FROZEN = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "openid",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/gmail.modify"
];

const WHY_THIS_IS_FROZEN = `
The Google Workspace scope set changed.

This is not a code review question, it is a compliance event. Our OAuth client is
verified, and per google-oauth-assets/casa/recert-runbook.md:129-131:

  "Any new sensitive or restricted scope, or any change to the OAuth consent
   screen configuration, requires a fresh verification request. Verification
   cannot be inherited."

Verification was granted 2026-08-10 and cost an ADA-CASA AL1 assessment: a DAST
scan, a 54-question SAQ, seven remediation PRs, and a Letter of Validation. The
restricted scope gmail.modify is what triggers that requirement, and losing it
takes down email for every tenant with a connected Gmail.

If you are ADDING a scope: you need a fresh verification request first, and a
sensitive or restricted one restarts the review. If you are REMOVING one:
narrowing is safe with Google, but check the feature first. calendar.app.created
backs the app-created NewCoworker calendar the public booking page depends on.

If the change is genuinely intended, update src/lib/google/workspace-scopes.ts
AND this test together, and say in the PR body which verification step covers it.
`;

describe("lib/google/workspace-scopes", () => {
  it("matches the frozen seven declared on the verified consent screen", () => {
    expect(GOOGLE_WORKSPACE_SCOPES, WHY_THIS_IS_FROZEN).toEqual(FROZEN);
  });

  it("never carries a scope that was deliberately dropped", () => {
    // gmail.settings.basic was removed in the Jul 2026 restart (restricted, and
    // no feature ever called it). drive.readonly was requested by the direct
    // Google code deleted in Apr 2026 and is not in the approved set.
    for (const banned of [
      "https://www.googleapis.com/auth/gmail.settings.basic",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/gmail.readonly"
    ]) {
      expect(GOOGLE_WORKSPACE_SCOPES as readonly string[], WHY_THIS_IS_FROZEN).not.toContain(banned);
    }
  });

  it("lists exactly the two scopes Google's verification covers", () => {
    expect(GOOGLE_VERIFIED_SCOPES).toEqual([
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    // Both must also be in the requested set, or we would be claiming coverage
    // for something we never ask for.
    for (const scope of GOOGLE_VERIFIED_SCOPES) {
      expect(GOOGLE_WORKSPACE_SCOPES as readonly string[]).toContain(scope);
    }
  });

  it("renders the scope param space delimited", () => {
    expect(googleWorkspaceScopeParam()).toBe(FROZEN.join(" "));
  });

  describe("googleGrantCovers", () => {
    it("reads the granted scope string, not the requested set", () => {
      const granted =
        "openid https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.modify";
      expect(googleGrantCovers(granted, "https://www.googleapis.com/auth/gmail.modify")).toBe(true);
      expect(googleGrantCovers(granted, "https://www.googleapis.com/auth/calendar.app.created")).toBe(
        false
      );
    });

    it("treats a partial grant as not covering the missing scope", () => {
      // Granular consent: the owner unticked Gmail. Every Gmail call would 403
      // forever, so the resolver has to be able to see this.
      const calendarOnly = "openid https://www.googleapis.com/auth/calendar.events";
      expect(googleGrantCovers(calendarOnly, "https://www.googleapis.com/auth/gmail.modify")).toBe(
        false
      );
    });

    it("is false for an absent or empty grant rather than throwing", () => {
      expect(googleGrantCovers(null, "openid")).toBe(false);
      expect(googleGrantCovers(undefined, "openid")).toBe(false);
      expect(googleGrantCovers("", "openid")).toBe(false);
    });

    it("does not match on a substring", () => {
      // "calendar.events" must not satisfy a check for "calendar.events.freebusy".
      const granted = "https://www.googleapis.com/auth/calendar.events";
      expect(
        googleGrantCovers(granted, "https://www.googleapis.com/auth/calendar.events.freebusy")
      ).toBe(false);
    });

    it("tolerates irregular whitespace in the granted string", () => {
      expect(googleGrantCovers("  openid   profile ", "openid")).toBe(true);
    });
  });
});
