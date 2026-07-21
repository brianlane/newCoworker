import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPLOY_CLIENT_SH,
  extractWorkflowJqProgram,
  renderWorkflowSeed,
  type SeedWorkflow
} from "../debug/_workflow-seed";
import { AGENT_TOOL_REGISTRY, findAgentToolDefinition } from "@/lib/agent-tools/registry";
import { TOOL_GATES, baseToolKey, toolSurface } from "@/lib/agent-tools/rowboat-gates";

/**
 * DRIFT GUARD: the registry (what each coworker SHOULD have), the Rowboat
 * workflow seed (what a fresh provision actually declares), the dispatcher
 * allowlist (what /api/rowboat/tool-call will fulfil), and the voice
 * bridge's declarations must stay in lockstep — every past gap (missing
 * scheduling tools on old boxes, the inline generate_image parity bug, the
 * send_whatsapp seed gap) was exactly this drift.
 *
 * The seed is validated by EXECUTING the WORKFLOW_JSON jq program extracted
 * from vps/scripts/deploy-client.sh (see debug/_workflow-seed.ts) — so a jq
 * syntax error or a stray apostrophe fails THIS test instead of the next
 * tenant's provision, and the assertions read structured JSON, not regexes.
 *
 * When this test fails after you add a tool: update the deploy-client.sh
 * seed (agent lists + workflow declaration), the dispatcher gates, and then
 * retrofit live boxes with `tsx debug/reseed-agent-tool-parity.ts --all`.
 */

const seed: SeedWorkflow = renderWorkflowSeed();

const agentTools = new Map(seed.agents.map((a) => [a.name, a.tools]));
const workflowToolNames = new Set(seed.tools.map((t) => t.name));

/** Registry toolKey → Rowboat seed name(s) per surface, with by-design exemptions. */
const DASHBOARD_NAME_MAP: Record<string, string[] | null> = {
  // Fulfilled by the chat-worker's email adapter (/api/voice/tools/dashboard-email),
  // not a Rowboat-declared tool — the worker intercepts email intents itself.
  send_email: null,
  send_sms: ["send_sms"],
  send_whatsapp: ["send_whatsapp"],
  // Worker-intercepted memory capture rides its own Rowboat tool name.
  memory_capture: ["owner_append_business_memory"],
  run_aiflow: ["dashboard_list_aiflows", "dashboard_run_aiflow"],
  // Inline-only by design (same posture as create_aiflow, which the seed
  // never carries): edits run the platform compile pipeline, which the
  // Rowboat worker fallback cannot host.
  edit_aiflow: null,
  // INLINE-ONLY by design: the dashboard settings-mutation tool is declared
  // only where the authed caller's manage_settings role is verified per turn
  // (the inline Gemini path). The Rowboat OwnerCoworker fallback carries no
  // caller role, so it deliberately gets no dashboard_ twin.
  update_notification_preferences: null
};

const WEBCHAT_CANONICAL = [
  "webchat_business_knowledge_lookup",
  "webchat_capture_lead",
  "webchat_calendar_find_slots",
  "webchat_calendar_book_appointment",
  "webchat_document_share"
];

function registrySurface(key: "dashboard" | "sms" | "webchat" | "voice") {
  const agent = AGENT_TOOL_REGISTRY.find((a) => a.key === key);
  if (!agent) throw new Error(`registry surface ${key} missing`);
  return agent;
}

describe("workflow seed (deploy-client.sh) executes and has the expected shape", () => {
  it("renders via jq with all six agents and the Coworker start agent", () => {
    expect(seed.agents.map((a) => a.name)).toEqual([
      "Coworker",
      "CoworkerLocal",
      "OwnerCoworker",
      "OwnerCoworkerLocal",
      "WebchatCoworker",
      "WebchatCoworkerLocal"
    ]);
    expect((seed as unknown as { startAgent: string }).startAgent).toBe("Coworker");
  });

  it("contains no apostrophes in the jq program (bash would truncate the seed)", () => {
    // extractWorkflowJqProgram throws when the program's first apostrophe is
    // not the closing quote — rendering above already proved it, but assert
    // explicitly so the failure message names the real constraint.
    const shText = fs.readFileSync(path.join(process.cwd(), DEPLOY_CLIENT_SH), "utf8");
    expect(() => extractWorkflowJqProgram(shText)).not.toThrow();
  });

  it("every tool a seeded agent declares has a workflow-level declaration", () => {
    for (const agent of seed.agents) {
      for (const tool of agent.tools) {
        expect(workflowToolNames.has(tool), `${agent.name} declares undeclared tool ${tool}`).toBe(
          true
        );
      }
    }
  });

  it("the Local spend-cap twins mirror their primary agent's tool surface exactly", () => {
    expect(agentTools.get("CoworkerLocal")).toEqual(agentTools.get("Coworker"));
    expect(agentTools.get("OwnerCoworkerLocal")).toEqual(agentTools.get("OwnerCoworker"));
    expect(agentTools.get("WebchatCoworkerLocal")).toEqual(agentTools.get("WebchatCoworker"));
  });
});

describe("registry ↔ seed parity per surface", () => {
  it("dashboard: every configurable registry tool is declared on OwnerCoworker (or exempt by design)", () => {
    const owner = agentTools.get("OwnerCoworker") ?? [];
    for (const tool of registrySurface("dashboard").tools) {
      if (!tool.configurable) continue;
      const mapped = DASHBOARD_NAME_MAP[tool.toolKey];
      if (mapped === null) continue; // by-design exemption
      const names = mapped ?? [`dashboard_${tool.toolKey}`];
      for (const name of names) {
        expect(owner, `dashboard tool ${tool.toolKey} → ${name} missing from OwnerCoworker seed`)
          .toContain(name);
      }
    }
  });

  it("sms: every configurable registry tool is declared bare on Coworker", () => {
    const coworker = agentTools.get("Coworker") ?? [];
    for (const tool of registrySurface("sms").tools) {
      if (!tool.configurable) continue;
      expect(coworker, `sms tool ${tool.toolKey} missing from Coworker seed`).toContain(
        tool.toolKey
      );
    }
  });

  it("webchat: the seed list is EXACTLY the restricted canonical set (threat model)", () => {
    expect([...(agentTools.get("WebchatCoworker") ?? [])].sort()).toEqual(
      [...WEBCHAT_CANONICAL].sort()
    );
    // Registry webchat tools all map onto that set (no registry tool without
    // a seed twin, no seed twin without a registry toggle).
    const fromRegistry = registrySurface("webchat")
      .tools.map((t) => `webchat_${t.toolKey}`)
      .sort();
    expect(fromRegistry).toEqual([...WEBCHAT_CANONICAL].sort());
  });
});

describe("seed ↔ dispatcher (TOOL_GATES) parity", () => {
  it("every seeded webhook tool has a dispatcher gate (unknown names fail closed)", () => {
    for (const tool of seed.tools) {
      if (tool.isWebhook !== true) continue; // worker-intercepted (owner_append_business_memory)
      expect(TOOL_GATES[tool.name], `webhook tool ${tool.name} has no TOOL_GATES entry`).toBeTruthy();
    }
  });

  it("every gate resolves to a real registry toggle", () => {
    for (const [name, gate] of Object.entries(TOOL_GATES)) {
      expect(
        findAgentToolDefinition(gate.agentKey, gate.toolKey),
        `gate ${name} points at unknown registry toggle ${gate.agentKey}/${gate.toolKey}`
      ).not.toBeNull();
    }
  });

  it("the webchat_ gate allowlist is exactly the canonical webchat set", () => {
    const webchatGates = Object.keys(TOOL_GATES)
      .filter((n) => n.startsWith("webchat_"))
      .sort();
    expect(webchatGates).toEqual([...WEBCHAT_CANONICAL].sort());
  });

  it("name-prefix helpers classify every seed name onto the right surface", () => {
    expect(baseToolKey("dashboard_document_list")).toBe("document_list");
    expect(baseToolKey("webchat_capture_lead")).toBe("capture_lead");
    expect(baseToolKey("send_sms")).toBe("send_sms");
    expect(toolSurface("dashboard_document_list")).toBe("dashboard");
    expect(toolSurface("webchat_capture_lead")).toBe("webchat");
    expect(toolSurface("send_email")).toBe("sms");
  });
});

describe("registry ↔ voice bridge parity", () => {
  it("every registry voice tool is declared in the bridge's tool-declarations", () => {
    const declText = fs.readFileSync(
      path.join(process.cwd(), "vps/voice-bridge/src/tool-declarations.ts"),
      "utf8"
    );
    for (const tool of registrySurface("voice").tools) {
      expect(
        declText.includes(`name: "${tool.toolKey}"`),
        `voice tool ${tool.toolKey} missing from vps/voice-bridge/src/tool-declarations.ts`
      ).toBe(true);
    }
  });
});
