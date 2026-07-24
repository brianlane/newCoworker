import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiFlowDefinitionSchema } from "@/lib/ai-flows/schema";

/**
 * Step-feature parity guard: every field of every AiFlow STEP schema must be
 * available on BOTH authoring surfaces:
 *
 *   1. the visual builder (src/components/dashboard/AiFlowsManager.tsx), and
 *   2. the AI-author vocabulary (src/lib/ai-flows/compile.ts, which also
 *      feeds edit_aiflow via the compile pipeline; the MCP get_flow_schema
 *      derives from the zod schema automatically and needs no pin).
 *
 * Mechanism (same philosophy as tests/agent-tool-seed-parity: scan the real
 * sources, so a schema addition that skips a surface fails THIS PR, not a
 * user): the step field names are introspected from the live zod schema and
 * must appear as whole words in each surface's source. This is a tripwire,
 * not a proof of a working control, but it forces the author of a new field
 * to touch (or consciously exempt in) both surfaces.
 *
 * BASELINE below is the pre-existing debt frozen at introduction
 * (2026-07-23): fields older than this guard that one surface does not
 * mention yet. NEVER add to it for new work; shrink it as gaps are fixed.
 * The guard fails when a baseline entry becomes stale (the gap was fixed but
 * the entry stayed), so it can only ratchet down.
 */

const ROOT = join(__dirname, "..");
const BUILDER_SRC = readFileSync(
  join(ROOT, "src/components/dashboard/AiFlowsManager.tsx"),
  "utf8"
);
const VOCAB_SRC = readFileSync(join(ROOT, "src/lib/ai-flows/compile.ts"), "utf8");

/** Fields every step shares; edited generically by the builder, not per-form. */
const GENERIC_FIELDS = new Set(["id", "type", "when"]);

type Surface = "builder" | "vocabulary";

/**
 * Pre-existing gaps at guard introduction. Key: `<stepType>.<field>`,
 * value: the surfaces that do not mention the field yet.
 */
const BASELINE: Record<string, Surface[]> = {
  // Populated from the initial run; see the ratchet test below.
};

/** Introspect the step discriminated union out of the live definition schema. */
function stepShapes(): { type: string; fields: string[] }[] {
  const def = aiFlowDefinitionSchema.shape as Record<string, unknown>;
  const steps = def.steps as { element?: unknown; def?: { element?: unknown } };
  const element = (steps.element ?? steps.def?.element) as {
    options?: unknown[];
    def?: { options?: unknown[] };
  };
  const options = (element.options ?? element.def?.options ?? []) as {
    shape: Record<string, { value?: string; def?: { values?: string[] } }>;
  }[];
  expect(options.length).toBeGreaterThan(10);
  return options.map((o) => {
    const typeField = o.shape.type;
    const type = typeField.value ?? typeField.def?.values?.[0];
    if (typeof type !== "string") throw new Error("step type literal not introspectable");
    return { type, fields: Object.keys(o.shape).filter((k) => !GENERIC_FIELDS.has(k)) };
  });
}

function mentions(src: string, field: string): boolean {
  return new RegExp(`\\b${field}\\b`).test(src);
}

describe("AiFlow step-field parity (visual builder + AI vocabulary)", () => {
  const shapes = stepShapes();

  it("every step field is available on both authoring surfaces (minus the frozen baseline)", () => {
    const missing: string[] = [];
    for (const { type, fields } of shapes) {
      for (const field of fields) {
        const key = `${type}.${field}`;
        const exempt = new Set(BASELINE[key] ?? []);
        if (!exempt.has("builder") && !mentions(BUILDER_SRC, field)) {
          missing.push(`${key} missing from the visual builder (AiFlowsManager.tsx)`);
        }
        if (!exempt.has("vocabulary") && !mentions(VOCAB_SRC, field)) {
          missing.push(`${key} missing from the AI-author vocabulary (compile.ts)`);
        }
      }
    }
    expect(
      missing,
      "New step fields must be wired into BOTH authoring surfaces (or consciously " +
        "added to this guard's frozen BASELINE with a justification comment):\n" +
        missing.join("\n")
    ).toEqual([]);
  });

  it("the baseline only ratchets down (stale entries must be removed)", () => {
    const stale: string[] = [];
    for (const [key, surfaces] of Object.entries(BASELINE)) {
      const [, field] = key.split(".");
      for (const surface of surfaces) {
        const src = surface === "builder" ? BUILDER_SRC : VOCAB_SRC;
        if (mentions(src, field)) {
          stale.push(`${key} (${surface}) is fixed; remove it from BASELINE`);
        }
      }
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("the route_to_team offer-set sources are all first-class on both surfaces", () => {
    // The gap that motivated this guard (agentNameVar existed engine-side
    // with no builder control): pin every offer-set source explicitly.
    for (const field of ["agentName", "agentNameVar", "agentRef", "agentNames", "broadcastAll"]) {
      expect(mentions(BUILDER_SRC, field), `builder: ${field}`).toBe(true);
      expect(mentions(VOCAB_SRC, field), `vocabulary: ${field}`).toBe(true);
    }
  });
});
