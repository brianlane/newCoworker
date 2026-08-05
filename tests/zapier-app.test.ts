import { describe, expect, it } from "vitest";
import { ZAPIER_APP_URL } from "@/lib/integrations/zapier-app";

describe("ZAPIER_APP_URL", () => {
  it("points at the public App Directory listing", () => {
    // Zapier approved app 243681 into the directory on 2026-08-04, so tenants
    // find New Coworker by searching in the Zap editor. The dashboard renders
    // this link, and a malformed value strands every tenant on the Zapier path.
    expect(ZAPIER_APP_URL).toBe("https://zapier.com/apps/new-coworker/integrations");
  });

  it("is not a per-version invite link", () => {
    // Invite links were minted PER PUSHED VERSION, so every `zapier-platform
    // push` silently stranded this constant on the previous version until
    // someone noticed (that is exactly what #1105 had to fix). A directory URL
    // is stable across versions, so that maintenance trap is retired. If the
    // integration were ever reverted to Private, restore the invite constant
    // from git history rather than reintroducing the drift by hand.
    expect(ZAPIER_APP_URL).not.toContain("public-invite");
  });
});
