import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { integrationKeepVolumes, repoRoot } from "../kvm-stack-helpers";

export const INTEGRATION_CORRECTNESS_RESPONSES_BASENAME = "integration-correctness-responses.json";

export type CorrectnessSmsTurnCapture = {
  turnIndex: number;
  userMessage: string;
  assistantText: string;
  roundTripMs: number;
};

export type CorrectnessSmsCapture = {
  id: string;
  difficulty: string;
  difficultyRank: number;
  /** One entry per user turn in the Rowboat thread (multi-turn E2E). */
  turns: CorrectnessSmsTurnCapture[];
  /** Sum of `roundTripMs` for the thread. */
  totalRoundTripMs: number;
};

export type CorrectnessStackCapture = {
  label: string;
  model: string;
  composeFile: string;
  scenarios: CorrectnessSmsCapture[];
};

export type IntegrationCorrectnessResponsesFile = {
  schemaVersion: 3;
  kind: "integration-correctness-responses";
  generatedAt: string;
  integrationKeepVolumes: boolean;
  env: {
    INTEGRATION_OLLAMA_MODEL_KVM8: string | null;
    INTEGRATION_OLLAMA_MODEL_KVM2: string | null;
    INTEGRATION_CORRECTNESS_MODEL_SEQUENCE: string | null;
  };
  stacks: CorrectnessStackCapture[];
};

export function buildCorrectnessResponsesShell(): IntegrationCorrectnessResponsesFile {
  return {
    schemaVersion: 3,
    kind: "integration-correctness-responses",
    generatedAt: new Date().toISOString(),
    integrationKeepVolumes: integrationKeepVolumes(),
    env: {
      INTEGRATION_OLLAMA_MODEL_KVM8: process.env.INTEGRATION_OLLAMA_MODEL_KVM8 ?? null,
      INTEGRATION_OLLAMA_MODEL_KVM2: process.env.INTEGRATION_OLLAMA_MODEL_KVM2 ?? null,
      INTEGRATION_CORRECTNESS_MODEL_SEQUENCE: process.env.INTEGRATION_CORRECTNESS_MODEL_SEQUENCE ?? null
    },
    stacks: []
  };
}

export function writeIntegrationCorrectnessResponsesFile(doc: IntegrationCorrectnessResponsesFile): void {
  const dir = join(repoRoot, "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, INTEGRATION_CORRECTNESS_RESPONSES_BASENAME), JSON.stringify(doc, null, 2), "utf8");
}
