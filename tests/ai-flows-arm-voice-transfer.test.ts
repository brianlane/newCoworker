/**
 * arm_voice_transfer — the "expect a live-transfer call" step (Jul 20 2026
 * Clever incident: the Cue flow replied "Y", the concierge called from a
 * number outside every per-caller routing rule, and the AI intake script ran
 * instead of the warm transfer).
 *
 * Covers the three layers a batch step spans:
 *   1. authoring schema (src/lib/ai-flows/schema.ts) — shape + exactly-one-
 *      target semantics;
 *   2. runtime planner (supabase/functions/_shared/ai_flows/steps.ts) —
 *      defaults, clamping, ref passthrough;
 *   3. test-mode simulation (no window row is ever written by a test run);
 * plus the migration's RLS/claim contract.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AiFlowValidationError,
  parseAiFlowDefinition,
  summarizeDefinition
} from "../src/lib/ai-flows/schema";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";
import { simulateTestAction } from "../supabase/functions/_shared/ai_flows/test_mode";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const REF = { source: "employee", id: "44444444-4444-4444-8444-444444444444", label: "Dave" } as const;

function cueDefinition(step: Record<string, unknown>): unknown {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 0,
      conditions: [
        { type: "from_matches", value: "3149071456" },
        { type: "contains", value: "LIVE TRANSFER", caseInsensitive: true }
      ]
    },
    steps: [
      { id: "cue", type: "send_sms", to: "{{trigger.from}}", body: "Y" },
      step
    ],
    options: { suppressDefaultReply: true }
  };
}

describe("arm_voice_transfer: authoring schema", () => {
  it("parses the Clever Cue shape (Y reply, then arm the window)", () => {
    const def = parseAiFlowDefinition(
      cueDefinition({
        id: "arm_transfer",
        type: "arm_voice_transfer",
        toE164: "+16025245719",
        windowMinutes: 20,
        whisper: "Connecting you now"
      })
    );
    expect(def.steps[1]).toMatchObject({
      type: "arm_voice_transfer",
      toE164: "+16025245719",
      windowMinutes: 20
    });
    expect(summarizeDefinition(def)).toContain("arm_voice_transfer");
  });

  it("accepts a saved-contact target (toRef) instead of a literal number", () => {
    const def = parseAiFlowDefinition(
      cueDefinition({ id: "arm", type: "arm_voice_transfer", toRef: REF })
    );
    expect(def.steps[1]).toMatchObject({ type: "arm_voice_transfer", toRef: REF });
  });

  it("rejects a window with no target", () => {
    expect(() =>
      parseAiFlowDefinition(cueDefinition({ id: "arm", type: "arm_voice_transfer" }))
    ).toThrowError(AiFlowValidationError);
    try {
      parseAiFlowDefinition(cueDefinition({ id: "arm", type: "arm_voice_transfer" }));
    } catch (err) {
      expect((err as AiFlowValidationError).issues.join("; ")).toContain(
        "arms a transfer window with no target"
      );
    }
  });

  it("rejects both toE164 and toRef", () => {
    try {
      parseAiFlowDefinition(
        cueDefinition({
          id: "arm",
          type: "arm_voice_transfer",
          toE164: "+16025245719",
          toRef: REF
        })
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AiFlowValidationError).issues.join("; ")).toContain(
        "sets both toE164 and toRef"
      );
    }
  });

  it("bounds windowMinutes to 1-120", () => {
    for (const windowMinutes of [0, 121]) {
      expect(() =>
        parseAiFlowDefinition(
          cueDefinition({
            id: "arm",
            type: "arm_voice_transfer",
            toE164: "+16025245719",
            windowMinutes
          })
        )
      ).toThrowError(AiFlowValidationError);
    }
  });
});

describe("arm_voice_transfer: runtime planner", () => {
  it("defaults the window to 20 minutes and passes the literal target through", () => {
    const plan = planStep(
      { id: "arm", type: "arm_voice_transfer", toE164: "+16025245719" } as FlowStep,
      { vars: {} }
    );
    expect(plan).toEqual({
      ok: true,
      action: { kind: "arm_voice_transfer", toE164: "+16025245719", windowMinutes: 20 }
    });
  });

  it("clamps a hand-written window to the schema bounds (raw JSONB defense)", () => {
    const high = planStep(
      {
        id: "arm",
        type: "arm_voice_transfer",
        toE164: "+16025245719",
        windowMinutes: 999
      } as FlowStep,
      { vars: {} }
    );
    expect(high).toMatchObject({ ok: true, action: { windowMinutes: 120 } });

    const low = planStep(
      {
        id: "arm",
        type: "arm_voice_transfer",
        toE164: "+16025245719",
        windowMinutes: 0
      } as FlowStep,
      { vars: {} }
    );
    expect(low).toMatchObject({ ok: true, action: { windowMinutes: 1 } });
  });

  it("passes toRef through UNRESOLVED (the worker resolves the live number) and trims the whisper", () => {
    const plan = planStep(
      {
        id: "arm",
        type: "arm_voice_transfer",
        toRef: REF,
        windowMinutes: 30,
        whisper: "  Connecting you now  "
      } as FlowStep,
      { vars: {} }
    );
    expect(plan).toEqual({
      ok: true,
      action: {
        kind: "arm_voice_transfer",
        toRef: REF,
        windowMinutes: 30,
        whisper: "Connecting you now"
      }
    });

    // A whitespace-only whisper is dropped, not sent as "".
    const blank = planStep(
      {
        id: "arm",
        type: "arm_voice_transfer",
        toE164: "+16025245719",
        whisper: "   "
      } as FlowStep,
      { vars: {} }
    );
    expect(blank).toEqual({
      ok: true,
      action: { kind: "arm_voice_transfer", toE164: "+16025245719", windowMinutes: 20 }
    });
  });
});

describe("arm_voice_transfer: test mode", () => {
  it("simulates without writing a window row (a test run must never hijack a real call)", () => {
    const scope = { vars: {} };
    const result = simulateTestAction(
      { kind: "arm_voice_transfer", toE164: "+16025245719", windowMinutes: 20 },
      scope
    );
    expect(result).toEqual({
      simulated: "arm_voice_transfer",
      to: "+16025245719",
      window_minutes: 20
    });
    expect(scope.vars).toEqual({});

    const refResult = simulateTestAction(
      { kind: "arm_voice_transfer", toRef: REF, windowMinutes: 5 },
      scope
    );
    expect(refResult).toEqual({
      simulated: "arm_voice_transfer",
      to_ref: "employee:44444444-4444-4444-8444-444444444444",
      window_minutes: 5
    });
  });
});

describe("voice_expected_transfers migration (contract)", () => {
  const migration = readFileSync(
    join(repoRoot, "supabase/migrations/20260816152334_voice_expected_transfers.sql"),
    "utf8"
  );

  it("one active window per business (PK), deny-by-default RLS with owner SELECT only", () => {
    expect(migration).toMatch(/business_id uuid primary key references public\.businesses/);
    expect(migration).toMatch(
      /alter table public\.voice_expected_transfers enable row level security/
    );
    expect(migration).toMatch(/create policy "Owner reads own voice_expected_transfers"/);
    expect(migration).toMatch(/for select/);
    // No INSERT/UPDATE/DELETE policies: writes are service-role only.
    expect(migration).not.toMatch(/for (insert|update|delete)/);
  });

  it("carries the consumption columns the webhook's atomic claim depends on", () => {
    expect(migration).toMatch(/expires_at timestamptz not null/);
    expect(migration).toMatch(/consumed_at timestamptz/);
    expect(migration).toMatch(/consumed_call_control_id text/);
  });
});

describe("telnyx-voice-inbound expected-transfer claim (contract)", () => {
  const handler = readFileSync(
    join(repoRoot, "supabase/functions/telnyx-voice-inbound/index.ts"),
    "utf8"
  );

  it("claims atomically (unexpired + unconsumed -> consumed) and falls through on error", () => {
    // The claim is a single conditional UPDATE — never a read-then-write pair
    // that two concurrent calls could both pass.
    expect(handler).toMatch(
      /from\("voice_expected_transfers"\)\s*\.update\(\{ consumed_at: [\s\S]*?\.is\("consumed_at", null\)\s*\.gt\("expires_at", [\s\S]*?\.select\("to_e164, whisper"\)/
    );
    // Runs AFTER the per-caller routing sources (exact matches win) and
    // logs + telemetry when it fires.
    expect(handler.indexOf('from("voice_caller_transfer_rules")')).toBeLessThan(
      handler.indexOf('from("voice_expected_transfers")')
    );
    expect(handler).toContain("voice_expected_transfer_matched");
  });
});
