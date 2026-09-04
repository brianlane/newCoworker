/**
 * MCP-to-Gemini bridge (src/lib/dashboard-chat/mcp-bridge.ts).
 *
 * The contracts pinned here keep the bridge honest as both sides evolve:
 * the partition is an exact disjoint cover of allMcpTools (tool #38 fails
 * CI until someone decides), no bridged name collides with an inline tool
 * (one tool per capability per surface), every bridged schema survives the
 * Gemini sanitizer, and the executor pins business scope no matter what
 * the model passes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { z } from "zod";
import { allMcpTools } from "@/lib/mcp/registry";
import { McpToolError } from "@/lib/mcp/auth";
import { defineMcpTool, TOOL_BEHAVIOR } from "@/lib/mcp/tooling";
import {
  ACTION_TOOL_NAMES
} from "@/lib/dashboard-chat/action-tools";
import {
  buildMcpBridgeExtraTools,
  executeMcpBridgeTool,
  isMcpBridgeToolName,
  MCP_BRIDGE_EXCLUDED,
  MCP_BRIDGE_GATE_KEYS,
  MCP_BRIDGE_SIDE_EFFECT_TOOLS,
  MCP_BRIDGE_TOOL_GATES,
  MCP_BRIDGE_OWNER_ONLY,
  MCP_BRIDGE_TOOL_ACTIONS,
  MCP_BRIDGE_TOOL_NAMES,
  mcpBridgeToolsPreamble,
  mcpBridgeDeclarations,
  mcpBridgeSideEffectNote,
  sanitizeSchemaNode,
  type McpBridgeGates
} from "@/lib/dashboard-chat/mcp-bridge";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OTHER_BIZ = "22222222-2222-4222-8222-222222222222";
const CALLER = { userId: "user-1", email: "owner@biz.com" };

function allGates(enabled: boolean): McpBridgeGates {
  return Object.fromEntries(
    MCP_BRIDGE_GATE_KEYS.map((k) => [k, enabled])
  ) as McpBridgeGates;
}

/** Inline tool names a fully-gated-on turn also declares alongside the bridge. */
const INLINE_TOOL_NAMES = new Set<string>([
  ...ACTION_TOOL_NAMES,
  "create_aiflow",
  "create_agent",
  "business_knowledge_lookup"
]);

/** Same-capability pairs that must never be co-declared on one surface. */
const CAPABILITY_MAP: Array<[string, string]> = [
  ["update_flow", "edit_aiflow"],
  ["create_flow", "create_aiflow"],
  ["list_flows", "list_aiflows"],
  ["run_flow", "run_aiflow"],
  ["create_employee", "manage_employee"],
  ["update_employee", "manage_employee"]
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the partition", () => {
  it("bridged + excluded is an exact disjoint cover of allMcpTools", () => {
    const bridged = new Set(MCP_BRIDGE_TOOL_NAMES);
    const excluded = new Set(Object.keys(MCP_BRIDGE_EXCLUDED));
    for (const name of bridged) {
      expect(excluded.has(name), `${name} is both bridged and excluded`).toBe(false);
    }
    const registryNames = new Set(allMcpTools.map((t) => t.name));
    const covered = new Set([...bridged, ...excluded]);
    for (const name of registryNames) {
      expect(
        covered.has(name),
        `MCP tool "${name}" has no bridge decision: add it to MCP_BRIDGE_TOOL_GATES or MCP_BRIDGE_EXCLUDED with a reason`
      ).toBe(true);
    }
    for (const name of covered) {
      expect(registryNames.has(name), `${name} is decided but not registered`).toBe(true);
    }
  });

  it("no bridged name collides with an inline tool name", () => {
    for (const name of MCP_BRIDGE_TOOL_NAMES) {
      expect(INLINE_TOOL_NAMES.has(name), `${name} collides with an inline tool`).toBe(false);
    }
  });

  it("no capability is reachable through two declared tools on one surface", () => {
    const declared = new Set<string>([
      ...INLINE_TOOL_NAMES,
      ...mcpBridgeDeclarations(allGates(true), "owner").map((d) => d.name)
    ]);
    for (const [a, b] of CAPABILITY_MAP) {
      expect(
        declared.has(a) && declared.has(b),
        `capability duplicate declared: ${a} and ${b}`
      ).toBe(false);
    }
  });

  it("every excluded tool records a reason and every bridged tool a gate", () => {
    for (const [name, reason] of Object.entries(MCP_BRIDGE_EXCLUDED)) {
      expect(reason.length, `${name} exclusion needs a reason`).toBeGreaterThan(20);
    }
    for (const name of MCP_BRIDGE_TOOL_NAMES) {
      expect(MCP_BRIDGE_GATE_KEYS).toContain(MCP_BRIDGE_TOOL_GATES[name]);
    }
    expect(isMcpBridgeToolName("get_sms_thread")).toBe(true);
    expect(isMcpBridgeToolName("send_sms")).toBe(false);
  });

  it("every bridged name has a handler-bar mirror, and owner-only is a bridged subset", () => {
    for (const name of MCP_BRIDGE_TOOL_NAMES) {
      expect(
        MCP_BRIDGE_TOOL_ACTIONS[name],
        `${name} has no MCP_BRIDGE_TOOL_ACTIONS entry`
      ).toBeTruthy();
    }
    expect(Object.keys(MCP_BRIDGE_TOOL_ACTIONS).sort()).toEqual(
      [...MCP_BRIDGE_TOOL_NAMES].sort()
    );
    for (const name of MCP_BRIDGE_OWNER_ONLY) {
      expect(isMcpBridgeToolName(name), `${name} owner-only but not bridged`).toBe(true);
    }
  });

  it("prunes declarations by the caller's role, mirroring the handler bars", () => {
    const ownerNames = mcpBridgeDeclarations(allGates(true), "owner").map((d) => d.name);
    const managerNames = mcpBridgeDeclarations(allGates(true), "manager").map((d) => d.name);
    const staffNames = mcpBridgeDeclarations(allGates(true), "staff").map((d) => d.name);

    // Owner sees everything.
    expect(ownerNames.sort()).toEqual([...MCP_BRIDGE_TOOL_NAMES].sort());
    // Manager loses only the owner-only knowledge pair.
    expect(managerNames).toContain("update_business_profile");
    expect(managerNames).toContain("set_flow_enabled");
    expect(managerNames).not.toContain("get_business_knowledge");
    expect(managerNames).not.toContain("update_business_knowledge");
    // Staff keep the reads their role can actually pass, and nothing that
    // would just burn tool steps on per-call refusals (Bugbot Medium on
    // PR #1382): no flow reads, no roster read, no settings read.
    expect(staffNames).toContain("search_contacts");
    expect(staffNames).toContain("get_sms_thread");
    expect(staffNames).toContain("create_contact");
    expect(staffNames).not.toContain("get_flow");
    expect(staffNames).not.toContain("list_agents");
    expect(staffNames).not.toContain("list_employees");
    expect(staffNames).not.toContain("get_notification_preferences");
    expect(staffNames).not.toContain("set_flow_enabled");
    expect(staffNames).not.toContain("update_business_profile");
  });

  it("every side-effect name is a bridged write with mutating/writing annotations", () => {
    for (const name of MCP_BRIDGE_SIDE_EFFECT_TOOLS) {
      expect(isMcpBridgeToolName(name), `${name} is not bridged`).toBe(true);
      const def = allMcpTools.find((t) => t.name === name);
      expect(def?.annotations.readOnlyHint, `${name} claims read-only`).toBe(false);
    }
    // And the inverse: every bridged non-read tool is side-effect classified.
    for (const name of MCP_BRIDGE_TOOL_NAMES) {
      const def = allMcpTools.find((t) => t.name === name);
      if (def && !def.annotations.readOnlyHint) {
        expect(
          MCP_BRIDGE_SIDE_EFFECT_TOOLS.has(name),
          `${name} writes but is not side-effect classified`
        ).toBe(true);
      }
    }
  });
});

describe("declarations", () => {
  it("declares only gated-on groups, strips business_id, keeps Gemini-legal keys", () => {
    const gates = { ...allGates(false), read_business_data: true };
    const decls = mcpBridgeDeclarations(gates, "owner");
    const names = decls.map((d) => d.name);
    expect(names).toContain("search_contacts");
    expect(names).toContain("get_sms_thread");
    expect(names).not.toContain("create_contact");
    expect(names).not.toContain("update_business_knowledge");

    const LEGAL_KEYS = new Set([
      "type",
      "description",
      "enum",
      "items",
      "properties",
      "required",
      "anyOf",
      "nullable"
    ]);
    const walk = (node: unknown, path: string) => {
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        expect(LEGAL_KEYS.has(key), `illegal schema key "${key}" at ${path}`).toBe(true);
        if (key === "type") {
          expect(typeof value, `schema type must be a string at ${path}`).toBe("string");
        }
        if (key === "properties") {
          for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
            walk(pv, `${path}.${pk}`);
          }
        } else if (key === "items") {
          walk(value, `${path}.items`);
        } else if (key === "anyOf") {
          for (const arm of value as unknown[]) walk(arm, `${path}.anyOf`);
        }
      }
    };
    for (const decl of mcpBridgeDeclarations(allGates(true), "owner")) {
      expect(decl.parameters.type).toBe("object");
      expect(Object.keys(decl.parameters.properties)).not.toContain("business_id");
      expect(decl.parameters.required ?? []).not.toContain("business_id");
      expect(decl.description.length).toBeGreaterThan(40);
      for (const [pk, pv] of Object.entries(decl.parameters.properties)) {
        walk(pv, `${decl.name}.${pk}`);
      }
    }
  });

  it("flattens [null, X] unions to nullable and folds const into enum", () => {
    const def = defineMcpTool({
      name: "get_sms_thread",
      title: "Fake for schema shapes",
      description: "Covers the sanitizer's union and const arms in one schema.",
      annotations: TOOL_BEHAVIOR.readLocal,
      outputSchema: z.object({ ok: z.boolean() }),
      schema: {
        business_id: z.string().uuid().optional(),
        day: z
          .union([z.null(), z.object({ open: z.string(), close: z.string() })])
          .describe("null closes the day"),
        mode: z.literal("fast").describe("only one mode"),
        tags: z.array(z.enum(["a", "b"])).optional(),
        choice: z.union([z.string(), z.number()]).optional()
      },
      handler: async () => ({ ok: true })
    });
    const [decl] = mcpBridgeDeclarations(
      { ...allGates(false), read_business_data: true },
      "owner",
      { tools: [def] }
    );
    const props = decl.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.day.nullable).toBe(true);
    expect(props.day.type).toBe("object");
    expect(props.day.description).toBe("null closes the day");
    expect(props.mode.enum).toEqual(["fast"]);
    expect(props.tags.items).toMatchObject({ enum: ["a", "b"] });
    expect(props.choice.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
    expect(decl.parameters.required).toEqual(["day", "mode"]);
  });

  it("drops a required business_id from the declaration like an optional one", () => {
    const def = defineMcpTool({
      name: "get_business",
      title: "Fake requiring business_id",
      description: "Covers stripping business_id out of the REQUIRED list too.",
      annotations: TOOL_BEHAVIOR.readLocal,
      outputSchema: z.object({ ok: z.boolean() }),
      schema: { business_id: z.string().uuid(), topic: z.string() },
      handler: async () => ({ ok: true })
    });
    const [decl] = mcpBridgeDeclarations(
      { ...allGates(false), read_business_data: true },
      "owner",
      { tools: [def] }
    );
    expect(Object.keys(decl.parameters.properties)).toEqual(["topic"]);
    expect(decl.parameters.required).toEqual(["topic"]);
  });

  it("the sanitizer guards non-object nodes and preserves multi-arm unions", () => {
    expect(sanitizeSchemaNode(null)).toEqual({});
    expect(sanitizeSchemaNode("string")).toEqual({});
    expect(
      sanitizeSchemaNode({
        anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
        description: "kept"
      })
    ).toMatchObject({ nullable: true, anyOf: [{ type: "string" }, { type: "number" }] });
    // Non-string entries in a malformed required list are dropped.
    expect(
      sanitizeSchemaNode({ type: "object", required: ["a", 5, "b"] })
    ).toEqual({ type: "object", required: ["a", "b"] });
    // A one-arm anyOf with NO null flattens without turning nullable, and
    // an inner description survives the outer one.
    expect(
      sanitizeSchemaNode({
        anyOf: [{ type: "string", description: "inner" }],
        description: "outer"
      })
    ).toEqual({ type: "string", description: "inner" });
    // A description-less nullable union flattens with no description at all.
    expect(
      sanitizeSchemaNode({ anyOf: [{ type: "null" }, { type: "string" }] })
    ).toEqual({ type: "string", nullable: true });
    // Empty required lists are dropped rather than emitted as [].
    expect(sanitizeSchemaNode({ type: "object", required: [] })).toEqual({
      type: "object"
    });
    // Zod 4.5+ compact simple unions to a JSON Schema type array. Gemini
    // does not accept that, so expand back to anyOf / nullable.
    expect(sanitizeSchemaNode({ type: ["string", "number"] })).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }]
    });
    expect(
      sanitizeSchemaNode({ type: ["string", "null"], description: "d" })
    ).toEqual({ type: "string", nullable: true, description: "d" });
    expect(sanitizeSchemaNode({ type: ["string", "number", "null"] })).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
      nullable: true
    });
    expect(sanitizeSchemaNode({ type: ["string"] })).toEqual({ type: "string" });
    // A type array that is not all strings is not a compact union: drop it.
    expect(sanitizeSchemaNode({ type: ["string", 1] })).toEqual({});
  });

  it("applies the fetch description override", () => {
    const decls = mcpBridgeDeclarations(allGates(true), "owner");
    const fetchDecl = decls.find((d) => d.name === "fetch");
    expect(fetchDecl?.description).toContain("list_call_transcripts");
  });

  it("buildMcpBridgeExtraTools returns null when every gate is off", () => {
    expect(buildMcpBridgeExtraTools(BIZ, CALLER, allGates(false), "owner")).toBeNull();
    // A missing role (no membership resolved) declares nothing either.
    expect(buildMcpBridgeExtraTools(BIZ, CALLER, allGates(true), null)).toBeNull();
    const bundle = buildMcpBridgeExtraTools(BIZ, CALLER, allGates(true), "owner");
    expect(bundle).not.toBeNull();
    expect(bundle!.sideEffectNames).toBe(MCP_BRIDGE_SIDE_EFFECT_TOOLS);
    expect(bundle!.noteFor).toBe(mcpBridgeSideEffectNote);
    expect(bundle!.declarations.length).toBe(MCP_BRIDGE_TOOL_NAMES.length);
  });

  it("the bundle's execute runs the pinned executor against the same tool set", async () => {
    const handler = vi.fn(async () => ({ found: 1 }));
    const bundle = buildMcpBridgeExtraTools(BIZ, CALLER, allGates(true), "owner", {
      tools: [
        defineMcpTool({
          name: "search_contacts",
          title: "Fake search",
          description: "Test double proving the bundle executes with its own deps.",
          annotations: TOOL_BEHAVIOR.readLocal,
          outputSchema: z.object({ ok: z.boolean() }),
          schema: {
            business_id: z.string().uuid().optional(),
            query: z.string().optional()
          },
          handler: handler as never
        })
      ]
    });
    const result = await bundle!.execute({
      name: "search_contacts",
      args: { query: "ally" }
    });
    expect(handler).toHaveBeenCalledWith(
      { query: "ally", business_id: BIZ },
      { userId: "user-1", email: "owner@biz.com" }
    );
    expect(result).toEqual({ ok: true, data: { found: 1 } });
  });
});

describe("executeMcpBridgeTool", () => {
  function fakeDef(
    name: string,
    handler: (args: Record<string, unknown>, auth: unknown) => Promise<unknown>
  ) {
    return defineMcpTool({
      name,
      title: `Fake ${name}`,
      description: "Test double standing in for the real connector tool.",
      annotations: TOOL_BEHAVIOR.readLocal,
      outputSchema: z.object({ ok: z.boolean() }),
      // The bridge parses through this schema (unknown keys strip, exactly
      // like the SDK on the connector path), so the double declares the
      // fields the tests send.
      schema: {
        business_id: z.string().uuid().optional(),
        query: z.string().optional(),
        id: z.string().optional()
      },
      handler: handler as never
    });
  }

  it("pins the business id over anything the model passed and runs as the caller", async () => {
    const handler = vi.fn(async () => ({ contacts: [] }));
    const result = await executeMcpBridgeTool(
      BIZ,
      CALLER,
      { name: "search_contacts", args: { query: "ally", business_id: OTHER_BIZ } },
      { tools: [fakeDef("search_contacts", handler)] }
    );
    expect(handler).toHaveBeenCalledWith(
      { query: "ally", business_id: BIZ },
      { userId: "user-1", email: "owner@biz.com" }
    );
    expect(result).toEqual({ ok: true, data: { contacts: [] } });
  });

  it("refuses a fetch id from another business with the generic wording", async () => {
    const handler = vi.fn(async () => ({}));
    const result = await executeMcpBridgeTool(
      BIZ,
      CALLER,
      { name: "fetch", args: { id: `contact:${OTHER_BIZ}:+15551234567` } },
      { tools: [fakeDef("fetch", handler)] }
    );
    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("not one this connector issued")
    });
    // A same-business id goes through.
    const okResult = await executeMcpBridgeTool(
      BIZ,
      CALLER,
      { name: "fetch", args: { id: `contact:${BIZ}:+15551234567` } },
      { tools: [fakeDef("fetch", handler)] }
    );
    expect(okResult).toEqual({ ok: true, data: {} });
    // A malformed id refuses through the parser's own McpToolError.
    const badResult = await executeMcpBridgeTool(
      BIZ,
      CALLER,
      { name: "fetch", args: { id: "gibberish" } },
      { tools: [fakeDef("fetch", handler)] }
    );
    expect(badResult).toMatchObject({ ok: false });
    // A non-string id takes the same parse-refusal path.
    const noId = await executeMcpBridgeTool(
      BIZ,
      CALLER,
      { name: "fetch", args: {} },
      { tools: [fakeDef("fetch", handler)] }
    );
    expect(noId).toMatchObject({ ok: false });
  });

  it("returns McpToolError messages honestly and degrades unknown errors", async () => {
    const refused = await executeMcpBridgeTool(
      BIZ,
      CALLER,
      { name: "get_contact", args: {} },
      {
        tools: [
          fakeDef("get_contact", async () => {
            throw new McpToolError("You don't have permission to do that on this business.");
          })
        ]
      }
    );
    expect(refused).toEqual({
      ok: false,
      message: "You don't have permission to do that on this business."
    });

    const crashed = await executeMcpBridgeTool(
      BIZ,
      CALLER,
      { name: "get_contact", args: {} },
      {
        tools: [
          fakeDef("get_contact", async () => {
            throw new Error("pg exploded");
          })
        ]
      }
    );
    expect(crashed).toEqual({
      ok: false,
      message: expect.stringContaining("internal error")
    });
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();

    const bare = await executeMcpBridgeTool(
      BIZ,
      CALLER,
      { name: "get_contact", args: {} },
      {
        tools: [
          fakeDef("get_contact", async () => {
            throw "bare";
          })
        ]
      }
    );
    expect(bare).toMatchObject({ ok: false });
  });

  it("validates arguments against the tool's own zod schema before the handler runs", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const def = defineMcpTool({
      name: "get_contact",
      title: "Fake with a strict schema",
      description: "Covers the bridge-side input validation the SDK did on the connector path.",
      annotations: TOOL_BEHAVIOR.readLocal,
      outputSchema: z.object({ ok: z.boolean() }),
      schema: {
        business_id: z.string().uuid().optional(),
        query: z.string().trim().min(2)
      },
      handler: handler as never
    });
    // Too short: refused with the field named, handler never runs.
    const refused = await executeMcpBridgeTool(
      BIZ,
      CALLER,
      { name: "get_contact", args: { query: "x" } },
      { tools: [def] }
    );
    expect(refused).toEqual({
      ok: false,
      message: expect.stringContaining("Invalid get_contact arguments: query")
    });
    expect(handler).not.toHaveBeenCalled();
    // Valid input reaches the handler PARSED (trim applied), not raw.
    await executeMcpBridgeTool(
      BIZ,
      CALLER,
      { name: "get_contact", args: { query: "  ally  " } },
      { tools: [def] }
    );
    expect(handler).toHaveBeenCalledWith(
      { query: "ally", business_id: BIZ },
      { userId: "user-1", email: "owner@biz.com" }
    );
    // A missing required field names the field too.
    const missing = await executeMcpBridgeTool(
      BIZ,
      CALLER,
      { name: "get_contact", args: {} },
      { tools: [def] }
    );
    expect(missing).toMatchObject({
      ok: false,
      message: expect.stringContaining("query")
    });
  });

  it("fails closed for names outside the bridged set", async () => {
    const result = await executeMcpBridgeTool(BIZ, CALLER, {
      name: "send_sms",
      args: { to: "+15551234567" }
    });
    expect(result).toEqual({ ok: false, message: "unknown tool: send_sms" });
  });
});

describe("side-effect notes and the preamble", () => {
  it("every side-effect tool has a specific fact line, others degrade generically", () => {
    for (const name of MCP_BRIDGE_SIDE_EFFECT_TOOLS) {
      const note = mcpBridgeSideEffectNote(name, { data: {} });
      expect(note.length).toBeGreaterThan(10);
      expect(note).not.toContain("went through.");
    }
    expect(mcpBridgeSideEffectNote("set_flow_enabled", { data: { enabled: true } })).toContain(
      "ON"
    );
    expect(mcpBridgeSideEffectNote("set_flow_enabled", { data: { enabled: false } })).toContain(
      "OFF"
    );
    expect(mcpBridgeSideEffectNote("something_else", null)).toContain("went through");
  });

  it("the preamble names the ladder, the boundary, and only real creation paths", () => {
    const withCreation = mcpBridgeToolsPreamble({ creationToolsDeclared: true });
    expect(withCreation).toContain("edit_aiflow");
    expect(withCreation).toContain("search_contacts");
    expect(withCreation).toContain("OUT OF SCOPE");
    expect(withCreation).toContain("phone number");
    expect(withCreation).toContain("create_aiflow");
    // Surfaces without the creation tools must not have it advertised
    // (owner-SMS and Slack pass includeCreationTools: false).
    const withoutCreation = mcpBridgeToolsPreamble({ creationToolsDeclared: false });
    expect(withoutCreation).toContain("NO creation tool on this surface");
    expect(withoutCreation).not.toContain("create_aiflow drafts");
    // The repo-wide ban applies to prompt copy most of all.
    for (const text of [withCreation, withoutCreation]) {
      expect(text).not.toContain("\u2014");
    }
  });
});
