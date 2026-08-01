import { describe, expect, it } from "vitest";
import { ZAPIER_INVITE_URL } from "@/lib/integrations/zapier-invite";

describe("ZAPIER_INVITE_URL", () => {
  it("is a Zapier public-invite URL for app 243681", () => {
    // The dashboard renders this as the mandatory first step for the Zapier
    // path; a malformed value would silently strand every tenant.
    expect(ZAPIER_INVITE_URL).toMatch(
      /^https:\/\/zapier\.com\/developer\/public-invite\/243681\/\d+\/[0-9a-f]+\/$/
    );
  });

  it("points at the current pushed version's invite (1.0.1), not a superseded one", () => {
    // Invite links are PER PUSHED VERSION (see the module note): after every
    // `zapier-platform push`, `users:links` mints a new id and this constant
    // must follow, or new tenants keep landing on the old version. 506906 is
    // the 1.0.1 invite. When you bump the app version, update BOTH the
    // constant and this pin in the same commit.
    expect(ZAPIER_INVITE_URL).toContain("/243681/506906/");
  });
});
