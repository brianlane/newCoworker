import { describe, expect, it } from "vitest";
import {
  GOOGLE_FAMILY_KEYS,
  MICROSOFT_FAMILY_KEYS,
  groupByWorkspaceFamily,
  workspaceFamilyOf
} from "@/lib/integrations/workspace-families";
import { GOOGLE_KEYS, OUTLOOK_KEYS } from "@/lib/workspace/reconnect";

describe("workspaceFamilyOf", () => {
  it("claims every Google key the reconnect matcher knows about", () => {
    // Not a restatement of the constant: a tenant still on a Nango-era key
    // (`gmail`, `google-mail`, `google-calendar`) must land on the Google
    // tile, not in the long-tail bucket where they would never find it.
    for (const key of GOOGLE_KEYS) {
      expect(workspaceFamilyOf(key)).toBe("google");
    }
    expect(GOOGLE_FAMILY_KEYS).toEqual(GOOGLE_KEYS);
  });

  it("claims Outlook mail AND the legacy calendar-only key", () => {
    for (const key of OUTLOOK_KEYS) {
      expect(workspaceFamilyOf(key)).toBe("microsoft");
    }
    // The deliberate divergence from OUTLOOK_KEYS: a connect must not RECONNECT
    // onto a calendar-only row, but the tile must still SHOW it, or the row is
    // stranded under a heading that does not describe it.
    expect(OUTLOOK_KEYS as readonly string[]).not.toContain("outlook-calendar");
    expect(workspaceFamilyOf("outlook-calendar")).toBe("microsoft");
    expect(MICROSOFT_FAMILY_KEYS).toContain("outlook-calendar");
  });

  it("sends the long tail to other, including keys a binary resolver calls Microsoft", () => {
    // providerFromKey (voice-tools) answers "microsoft" for all of these,
    // because it only has two answers. Display needs a third.
    expect(workspaceFamilyOf("onedrive")).toBe("other");
    expect(workspaceFamilyOf("slack")).toBe("other");
    expect(workspaceFamilyOf("zoom")).toBe("other");
    expect(workspaceFamilyOf("some-crm")).toBe("other");
    expect(workspaceFamilyOf("")).toBe("other");
  });

  it("normalizes case and stray whitespace before matching", () => {
    expect(workspaceFamilyOf("  GOOGLE-Mail ")).toBe("google");
    expect(workspaceFamilyOf("Outlook")).toBe("microsoft");
  });
});

describe("groupByWorkspaceFamily", () => {
  it("splits rows into the three tiles and keeps input order within each", () => {
    const rows = [
      { id: "g1", key: "google" },
      { id: "o1", key: "onedrive" },
      { id: "m1", key: "outlook" },
      { id: "g2", key: "gmail" },
      { id: "m2", key: "outlook-calendar" },
      { id: "o2", key: "some-crm" }
    ];
    const grouped = groupByWorkspaceFamily(rows, (r) => r.key);
    // Order matters: the pages render oldest-first, which is the order the
    // loader already sorted them into.
    expect(grouped.google.map((r) => r.id)).toEqual(["g1", "g2"]);
    expect(grouped.microsoft.map((r) => r.id)).toEqual(["m1", "m2"]);
    expect(grouped.other.map((r) => r.id)).toEqual(["o1", "o2"]);
  });

  it("returns all three buckets even when empty, so callers never guard", () => {
    expect(groupByWorkspaceFamily([], (r: { key: string }) => r.key)).toEqual({
      google: [],
      microsoft: [],
      other: []
    });
  });
});
