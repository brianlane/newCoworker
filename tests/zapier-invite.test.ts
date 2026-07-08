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
});
