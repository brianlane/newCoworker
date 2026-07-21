/**
 * Step-editor variables palette (src/lib/ai-flows/variables-palette.ts):
 * trigger fields per channel, earlier-step vars with name-part variants,
 * the always-available scope, dedupe across multiple triggers, and the
 * name-like heuristic.
 */
import { describe, expect, it } from "vitest";

import {
  isNameLikeVar,
  variablesPaletteGroups
} from "@/lib/ai-flows/variables-palette";
import type { FlowStep } from "@/lib/ai-flows/schema";

const STEPS: FlowStep[] = [
  {
    id: "s1",
    type: "extract_text",
    fields: [{ name: "lead_name" }, { name: "lead_phone" }]
  },
  { id: "s2", type: "send_sms", to: "{{vars.lead_phone}}", body: "hi" },
  { id: "s3", type: "notify_owner", message: "done" }
] as FlowStep[];

describe("isNameLikeVar", () => {
  it("matches person-name identifiers only", () => {
    expect(isNameLikeVar("lead_name")).toBe(true);
    expect(isNameLikeVar("contact_name")).toBe(true);
    expect(isNameLikeVar("owner_name")).toBe(true);
    expect(isNameLikeVar("lead_phone")).toBe(false);
    expect(isNameLikeVar("document_name")).toBe(false);
    expect(isNameLikeVar("file_name")).toBe(false);
    expect(isNameLikeVar("event_name")).toBe(false);
    expect(isNameLikeVar("business_name")).toBe(false);
    expect(isNameLikeVar("company_name")).toBe(false);
  });
});

describe("variablesPaletteGroups", () => {
  it("earlier-step vars respect flow order and name-like vars carry .first/.last variants", () => {
    const groups = variablesPaletteGroups({ steps: STEPS, stepId: "s2", channels: ["sms"] });
    const placeholders = groups.earlier.map((e) => e.placeholder);
    expect(placeholders).toEqual(["{{vars.lead_name}}", "{{vars.lead_phone}}"]);
    const leadName = groups.earlier[0];
    expect(leadName.nameParts).toEqual({
      first: "{{vars.lead_name.first}}",
      last: "{{vars.lead_name.last}}"
    });
    expect(groups.earlier[1].nameParts).toBeUndefined();
  });

  it("the FIRST step sees no earlier vars (empty state)", () => {
    const groups = variablesPaletteGroups({ steps: STEPS, stepId: "s1", channels: ["sms"] });
    expect(groups.earlier).toEqual([]);
  });

  it("message channels get the common trio plus channel-specific fields", () => {
    const sms = variablesPaletteGroups({ steps: STEPS, stepId: "s1", channels: ["sms"] });
    const smsPlaceholders = sms.trigger.map((e) => e.placeholder);
    expect(smsPlaceholders).toContain("{{trigger.from}}");
    expect(smsPlaceholders).toContain("{{trigger.windowText}}");
    expect(smsPlaceholders).toContain("{{trigger.url}}");
    expect(smsPlaceholders).toContain("{{trigger.image}}");

    const calendar = variablesPaletteGroups({
      steps: STEPS,
      stepId: "s1",
      channels: ["calendar"]
    });
    const calPlaceholders = calendar.trigger.map((e) => e.placeholder);
    expect(calPlaceholders).toContain("{{trigger.event_title}}");
    expect(calPlaceholders).toContain("{{trigger.starts_at}}");
    expect(calPlaceholders).toContain("{{trigger.ends_at}}");

    const tenantEmail = variablesPaletteGroups({
      steps: STEPS,
      stepId: "s1",
      channels: ["tenant_email"]
    });
    const tePlaceholders = tenantEmail.trigger.map((e) => e.placeholder);
    expect(tePlaceholders).toContain("{{trigger.document}}");
    expect(tePlaceholders).toContain("{{trigger.document_name}}");
    // document_name is a filename, not a person — no name parts.
    expect(
      tenantEmail.trigger.find((e) => e.placeholder === "{{trigger.document_name}}")?.nameParts
    ).toBeUndefined();
  });

  it("contact-event channels expose the contact fields (with name parts on contact_name)", () => {
    for (const channel of ["contact_created", "tag_changed", "owner_assigned", "birthday"]) {
      const groups = variablesPaletteGroups({ steps: STEPS, stepId: "s1", channels: [channel] });
      const contactName = groups.trigger.find(
        (e) => e.placeholder === "{{trigger.contact_name}}"
      );
      expect(contactName, channel).toBeDefined();
      expect(contactName?.nameParts).toEqual({
        first: "{{trigger.contact_name.first}}",
        last: "{{trigger.contact_name.last}}"
      });
    }
    const tag = variablesPaletteGroups({ steps: STEPS, stepId: "s1", channels: ["tag_changed"] });
    expect(tag.trigger.map((e) => e.placeholder)).toContain("{{trigger.tag}}");
    const owner = variablesPaletteGroups({
      steps: STEPS,
      stepId: "s1",
      channels: ["owner_assigned"]
    });
    expect(owner.trigger.map((e) => e.placeholder)).toContain("{{trigger.owner_name}}");
  });

  it("non-message channels (schedule) get no trigger trio; contact channels skip it too", () => {
    const schedule = variablesPaletteGroups({
      steps: STEPS,
      stepId: "s1",
      channels: ["schedule"]
    });
    expect(schedule.trigger).toEqual([]);

    const contact = variablesPaletteGroups({
      steps: STEPS,
      stepId: "s1",
      channels: ["contact_created"]
    });
    expect(contact.trigger.map((e) => e.placeholder)).not.toContain("{{trigger.windowText}}");
  });

  it("dedupes entries across multiple trigger channels", () => {
    const groups = variablesPaletteGroups({
      steps: STEPS,
      stepId: "s1",
      channels: ["sms", "tenant_email"]
    });
    const images = groups.trigger.filter((e) => e.placeholder === "{{trigger.image}}");
    expect(images).toHaveLength(1);
    const froms = groups.trigger.filter((e) => e.placeholder === "{{trigger.from}}");
    expect(froms).toHaveLength(1);
  });

  it("the always group carries actions_taken, the coworker address, and relative dates", () => {
    const groups = variablesPaletteGroups({ steps: STEPS, stepId: "s1", channels: ["manual"] });
    const placeholders = groups.always.map((e) => e.placeholder);
    expect(placeholders).toEqual([
      "{{vars.actions_taken}}",
      "{{coworker.email}}",
      "{{now.today.iso}}",
      "{{now.tomorrow.iso}}"
    ]);
    // Every always entry carries a hint (they are engine concepts, not
    // owner-authored fields).
    expect(groups.always.every((e) => typeof e.hint === "string")).toBe(true);
  });
});
