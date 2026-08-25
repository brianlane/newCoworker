/**
 * Guard: every MCP tool carries correct client-facing metadata.
 *
 * Why this is a test and not a code review note: missing or wrong behavior
 * annotations are the single most-cited reason OpenAI rejects a plugin, and
 * every one of these fields is optional in the SDK's config type. A tool that
 * forgot them, or that claims to be read-only while it sends a text, still
 * type-checks and still deploys. Only an assertion over the registry catches
 * it.
 *
 * The consistency rules below are deliberately about CONTRADICTIONS rather
 * than taste. They cannot tell you the right annotation for a new tool, but
 * they catch the way a wrong one actually arrives: a preset copy-pasted from
 * the tool above it.
 */

import { describe, expect, it } from "vitest";
import { allMcpTools } from "@/lib/mcp/registry";
import { TOOL_BEHAVIOR } from "@/lib/mcp/tooling";

/** MCP tool names are snake_case; ChatGPT also rejects vague ones. */
const NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * Prefixes whose meaning is settled: these replace or remove existing state,
 * so they can be neither read-only nor purely additive.
 */
const MUTATING_PREFIXES = ["delete_", "update_", "set_"];

describe("MCP tool metadata", () => {
  /**
   * The one assertion here that is a hard external gate rather than our own
   * taste: ChatGPT rejects a connector lacking either tool unless the user has
   * Developer Mode on, and both must be read-only to qualify as a knowledge
   * source. Passing in Developer Mode proves nothing about the normal install.
   */
  it("ships the search and fetch pair ChatGPT requires, both read-only", () => {
    for (const name of ["search", "fetch"]) {
      const tool = allMcpTools.find((t) => t.name === name);
      expect(tool, `${name} is missing; ChatGPT would reject the connector`).toBeDefined();
      expect(tool?.annotations.readOnlyHint, `${name} must be read-only`).toBe(true);
    }
  });

  it("registers at least the tools we think it does", () => {
    // Cheap canary: a registry that silently emptied would pass every
    // per-tool loop below, because a loop over nothing asserts nothing.
    expect(allMcpTools.length).toBeGreaterThanOrEqual(41);
  });

  for (const tool of allMcpTools) {
    describe(tool.name, () => {
      it("has a well-formed name", () => {
        expect(tool.name).toMatch(NAME_PATTERN);
      });

      it("has a human-readable title that fits a client's tool list", () => {
        expect(tool.title.trim()).not.toBe("");
        expect(tool.title.length).toBeLessThanOrEqual(40);
        // A title is a label, not a sentence.
        expect(tool.title.endsWith(".")).toBe(false);
        expect(tool.title).not.toBe(tool.name);
      });

      it("has a description long enough to tell the model when to use it", () => {
        expect(tool.description.length).toBeGreaterThan(40);
      });

      it("declares all three behavior hints as booleans", () => {
        expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
        expect(typeof tool.annotations.destructiveHint).toBe("boolean");
        expect(typeof tool.annotations.openWorldHint).toBe("boolean");
      });

      it("does not claim to be both read-only and destructive", () => {
        if (tool.annotations.readOnlyHint) {
          expect(tool.annotations.destructiveHint).toBe(false);
        }
      });

      it("annotates a mutating name as mutating", () => {
        if (MUTATING_PREFIXES.some((p) => tool.name.startsWith(p))) {
          expect(tool.annotations.readOnlyHint).toBe(false);
          expect(tool.annotations.destructiveHint).toBe(true);
        }
      });

      it("uses one of the shared presets rather than hand-rolled booleans", () => {
        // Not pedantry: the presets are where the reasoning lives, and an
        // inline combination is how a tool ends up with a shape nobody chose.
        expect(Object.values(TOOL_BEHAVIOR)).toContainEqual(tool.annotations);
      });
    });
  }

  it("gives every tool a distinct title", () => {
    const titles = allMcpTools.map((t) => t.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("marks every tool that reaches a customer or a third party as open-world", () => {
    // Pinned by name, because the rule is about what a call SETS IN MOTION and
    // no static check can see that. The two contact writers are the ones worth
    // guarding: they read as plain CRM writes, but each fires contact events
    // that enqueue AiFlows, and those can text or email the person. A future
    // edit that "tidied" them back to writeLocal/mutateLocal would be telling
    // ChatGPT it can add and edit contacts without asking.
    const OPEN_WORLD = [
      "send_sms",
      "send_whatsapp",
      "calendar_find_slots",
      "calendar_book_appointment",
      "trigger_flow",
      "run_flow",
      "create_contact",
      "update_contact"
    ];
    for (const name of OPEN_WORLD) {
      const tool = allMcpTools.find((t) => t.name === name);
      expect(tool, `${name} is missing from the registry`).toBeDefined();
      expect(tool?.annotations.openWorldHint, `${name} should be open-world`).toBe(true);
    }
  });

  it("marks the flow runners as destructive, because the flow body decides", () => {
    // trigger_flow and run_flow start owner-authored automations. An
    // update_contact step inside one can carry removeTags, so a call that
    // looks purely additive can delete CRM state. Calling these additive is
    // the kind of wrong annotation that reassures rather than warns.
    for (const name of ["trigger_flow", "run_flow"]) {
      const tool = allMcpTools.find((t) => t.name === name);
      expect(tool?.annotations.destructiveHint, `${name} should be destructive`).toBe(true);
    }
  });

  it("keeps every read tool non-destructive and every send tool not read-only", () => {
    for (const tool of allMcpTools) {
      if (tool.name.startsWith("list_") || tool.name.startsWith("get_")) {
        expect(tool.annotations.readOnlyHint, `${tool.name} should be read-only`).toBe(true);
      }
      if (tool.name.startsWith("send_") || tool.name.startsWith("create_")) {
        expect(tool.annotations.readOnlyHint, `${tool.name} should not be read-only`).toBe(
          false
        );
      }
    }
  });
});
