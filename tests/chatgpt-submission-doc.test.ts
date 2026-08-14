/**
 * Keeps the submission doc's annotation table in step with the registry.
 *
 * The OpenAI plugin form requires a written justification for every behavior
 * annotation on every tool, and mis-annotating a tool is the most-cited cause
 * of rejection. Those justifications are re-typed into a web form by hand, so
 * the doc is the source we copy from. A tool added, removed or re-annotated
 * without touching the doc would leave us pasting a stale claim into a
 * submission, which is the one place a quiet drift becomes a false statement
 * to a reviewer rather than a bug we notice.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allMcpTools } from "@/lib/mcp/registry";

const DOC = readFileSync(
  join(process.cwd(), "docs/CHATGPT-SUBMISSION-TESTS.md"),
  "utf8"
);

/** The doc prints True/False, the annotations are booleans. */
function shown(value: boolean): string {
  return value ? "True" : "False";
}

describe("the ChatGPT submission doc's annotation justifications", () => {
  it("covers every registered tool", () => {
    for (const tool of allMcpTools) {
      expect(DOC, `${tool.name} has no section in the doc`).toContain(
        `### \`${tool.name}\``
      );
    }
  });

  it("states the annotation values the registry actually advertises", () => {
    for (const tool of allMcpTools) {
      // Slice to this tool's section so a value asserted here cannot be
      // satisfied by an identical line under some other tool.
      const start = DOC.indexOf(`### \`${tool.name}\``);
      const rest = DOC.slice(start + 1);
      const nextHeading = rest.indexOf("\n### ");
      const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

      const a = tool.annotations;
      expect(section, `${tool.name} Read Only`).toContain(
        `**Read Only: ${shown(a.readOnlyHint)}**`
      );
      expect(section, `${tool.name} Open World`).toContain(
        `**Open World: ${shown(a.openWorldHint)}**`
      );
      expect(section, `${tool.name} Destructive`).toContain(
        `**Destructive: ${shown(a.destructiveHint)}**`
      );
    }
  });

  it("documents no tool that is not registered", () => {
    // The other direction: a tool deleted from the registry leaves a section
    // behind, and we would paste a justification for a tool that is gone.
    const documented = Array.from(DOC.matchAll(/^### `([a-z][a-z0-9_]*)`$/gm)).map(
      (m) => m[1]
    );
    const registered = new Set(allMcpTools.map((t) => t.name));
    for (const name of documented) {
      expect(registered.has(name), `${name} is documented but not registered`).toBe(
        true
      );
    }
    expect(documented).toHaveLength(allMcpTools.length);
  });

  it("gives each annotation a justification, not just a value", () => {
    // A bare "**Read Only: True**" with nothing after it would satisfy the
    // checks above while telling a reviewer nothing.
    const lines = DOC.split("\n").filter((l) =>
      /^- \*\*(Read Only|Open World|Destructive): (True|False)\*\*/.test(l)
    );
    expect(lines).toHaveLength(allMcpTools.length * 3);
    for (const line of lines) {
      const prose = line.replace(
        /^- \*\*(Read Only|Open World|Destructive): (True|False)\*\*\s*/,
        ""
      );
      expect(prose.length, `too short: ${line}`).toBeGreaterThan(30);
    }
  });
});
