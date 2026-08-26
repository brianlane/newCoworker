import { describe, expect, it } from "vitest";
import {
  OWNER_SURFACES,
  ownerSurfaceByFlowEditSource,
  ownerSurfaceByKey
} from "@/lib/owner-surfaces/registry";
import { describeEditSource } from "@/lib/ai-flows/version-history";
import { shouldAnnounceFlowChange } from "@/lib/ai-flows/change-notice";

/**
 * One entry per coworker surface, so adding the next one is a registry row
 * rather than an archaeology exercise.
 *
 * Before this existed, a surface's identity was spread across four files
 * that could not see each other: the announce set and the owner-facing
 * label in change-notice.ts, the history label in version-history.ts, and
 * the custom-table source map in action-tools.ts. Slack was added in PR
 * #1382 and needed all four edited by hand; a surface that missed one
 * looked correct everywhere except the single place it was forgotten.
 */

describe("OWNER_SURFACES", () => {
  it("has a unique key and a unique flow-edit source per surface", () => {
    const keys = OWNER_SURFACES.map((s) => s.key);
    const sources = OWNER_SURFACES.map((s) => s.flowEditSource);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it("gives every surface all four provenance strings", () => {
    // The whole point: a new surface cannot be half-registered.
    for (const surface of OWNER_SURFACES) {
      expect(surface.flowEditSource, surface.key).toMatch(/^ai_edit_/);
      expect(surface.customTableSource.length, surface.key).toBeGreaterThan(0);
      expect(surface.changeNoticeLabel.length, surface.key).toBeGreaterThan(0);
      expect(surface.historyLabel.length, surface.key).toBeGreaterThan(0);
      expect(surface.label.length, surface.key).toBeGreaterThan(0);
      expect(surface.description.length, surface.key).toBeGreaterThan(0);
    }
  });

  it("looks a surface up by key and by flow-edit source", () => {
    const sms = ownerSurfaceByKey("sms");
    expect(sms?.flowEditSource).toBe("ai_edit_sms");
    expect(ownerSurfaceByFlowEditSource("ai_edit_sms")).toBe(sms);
  });

  it("returns null for anything it does not own", () => {
    // `dashboard` (the builder), `mcp`, and `white_glove` are real edit
    // sources that are NOT coworker surfaces; the registry must not claim
    // them, or their labels would silently change.
    expect(ownerSurfaceByFlowEditSource("white_glove")).toBeNull();
    expect(ownerSurfaceByFlowEditSource("dashboard")).toBeNull();
    expect(ownerSurfaceByFlowEditSource(null)).toBeNull();
    expect(ownerSurfaceByFlowEditSource(undefined)).toBeNull();
    expect(ownerSurfaceByKey("nope" as never)).toBeNull();
  });

  it("covers WhatsApp, the surface this registry was built to add", () => {
    const wa = ownerSurfaceByKey("whatsapp");
    expect(wa?.flowEditSource).toBe("ai_edit_whatsapp");
  });
});

describe("the four call sites still answer exactly as before", () => {
  // Character-for-character pins. These strings reach owners (a text about
  // a flow that changed) and the version-history UI, so the refactor must
  // not reword them, only relocate them.
  it("describeEditSource is unchanged for every pre-existing source", () => {
    expect(describeEditSource("dashboard")).toBe("Edited in the builder");
    expect(describeEditSource("dashboard_restore")).toBe("Restored from history");
    expect(describeEditSource("ai_edit")).toBe("Edited by your coworker");
    expect(describeEditSource("ai_edit_sms")).toBe("Edited by your coworker, by text");
    expect(describeEditSource("ai_edit_email")).toBe("Edited by your coworker, by email");
    expect(describeEditSource("ai_edit_slack")).toBe("Edited by your coworker, in Slack");
    expect(describeEditSource("ai_edit_dashboard")).toBe(
      "Edited by your coworker, in dashboard chat"
    );
    expect(describeEditSource("mcp")).toBe("Edited through a connected app");
    expect(describeEditSource("mcp_restore")).toBe("Restored through a connected app");
    expect(describeEditSource("white_glove")).toBe("Edited by the New Coworker team");
    expect(describeEditSource(null)).toBe("An earlier change");
    expect(describeEditSource("something_new")).toBe("An earlier change");
  });

  it("describes the newly registered WhatsApp surface too", () => {
    expect(describeEditSource("ai_edit_whatsapp")).toBe(
      "Edited by your coworker, on WhatsApp"
    );
  });

  it("shouldAnnounceFlowChange is unchanged, and now includes WhatsApp", () => {
    for (const source of [
      "ai_edit_sms",
      "ai_edit_email",
      "ai_edit_slack",
      "ai_edit_dashboard",
      "mcp",
      "mcp_restore",
      "ai_edit_whatsapp"
    ]) {
      expect(shouldAnnounceFlowChange(source), source).toBe(true);
    }
    for (const source of ["dashboard", "white_glove", "ai_edit", undefined]) {
      expect(shouldAnnounceFlowChange(source), String(source)).toBe(false);
    }
  });
});
