import { describe, expect, it } from "vitest";
import {
  INTEGRATION_CATEGORIES,
  INTEGRATIONS,
  getIntegration
} from "@/lib/integrations/registry";

describe("integrations registry", () => {
  it("resolves every registered slug and rejects unknown ones", () => {
    for (const def of INTEGRATIONS) {
      expect(getIntegration(def.slug)).toBe(def);
    }
    expect(getIntegration("not-a-real-integration")).toBeNull();
    expect(getIntegration("")).toBeNull();
  });

  it("has unique slugs and only known categories", () => {
    const slugs = INTEGRATIONS.map((i) => i.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const def of INTEGRATIONS) {
      expect(INTEGRATION_CATEGORIES).toContain(def.category);
    }
  });

  it("splits workspace OAuth into Google, Microsoft 365, and a trailing catch-all", () => {
    const workspaceSection = INTEGRATIONS.filter((i) => i.category === "Workspace").map(
      (i) => i.slug
    );
    expect(workspaceSection).toContain("google");
    expect(workspaceSection).toContain("microsoft");
    // The catch-all renders last in its section: it is defined by what the
    // named tiles above it do not cover, so listing it first reads as the
    // default choice.
    expect(workspaceSection[workspaceSection.length - 1]).toBe("workspace");
    expect(getIntegration("workspace")?.name).toBe("Other 3rd Party Connections");
  });

  it("marks only the API-key surface as owner-only", () => {
    const ownerOnly = INTEGRATIONS.filter((i) => i.ownerOnly).map((i) => i.slug);
    expect(ownerOnly).toEqual(["zapier-api"]);
  });
});
