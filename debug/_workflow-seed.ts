/**
 * Canonical Rowboat workflow seed, extracted from the LIVE source of truth:
 * the `WORKFLOW_JSON=$(jq -nc … '<program>')` block in
 * vps/scripts/deploy-client.sh.
 *
 * Instead of duplicating the agent tool lists + tool declarations (the
 * "keep in lockstep" comments that have drifted before), this module pulls
 * the jq program out of the deploy script's text and EXECUTES it with jq —
 * so the reseed script (debug/reseed-agent-tool-parity.ts) and the CI
 * parity test (tests/agent-tool-seed-parity.test.ts) both read the exact
 * workflow a fresh provision would seed, and running it at all proves the
 * jq program still parses (a seed typo fails CI instead of the next
 * tenant's provision).
 *
 * Extraction contract: the jq program is single-quoted by the surrounding
 * bash, so it can contain NO apostrophes (deploy-client.sh documents this
 * next to the tool descriptions). That makes "the text between the first
 * quote after `jq -nc` and the next quote" a faithful extraction.
 *
 * Pure module: no env loading, no side effects at import time (tests import
 * it under vitest; debug scripts import it under tsx).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type SeedWorkflowAgent = {
  name: string;
  type: string;
  disabled: boolean;
  model: string;
  tools: string[];
};

export type SeedWorkflowTool = {
  name: string;
  description: string;
  /** Absent on worker-intercepted tools (owner_append_business_memory). */
  isWebhook?: boolean;
  parameters: Record<string, unknown>;
};

export type SeedWorkflow = {
  agents: SeedWorkflowAgent[];
  tools: SeedWorkflowTool[];
  prompts: { name: string; type: string; prompt: string }[];
};

/** Repo-root-relative path of the deploy script the seed lives in. */
export const DEPLOY_CLIENT_SH = "vps/scripts/deploy-client.sh";

/**
 * Pull the jq program out of the deploy script text. Throws when the block
 * can't be located — a refactor that moves it must update this extractor.
 */
export function extractWorkflowJqProgram(deployScriptText: string): string {
  const anchor = "WORKFLOW_JSON=$(jq -nc";
  const anchorAt = deployScriptText.indexOf(anchor);
  if (anchorAt < 0) {
    throw new Error(`could not find \`${anchor}\` in deploy-client.sh`);
  }
  const openQuote = deployScriptText.indexOf("'", anchorAt);
  if (openQuote < 0) {
    throw new Error("could not find the jq program's opening quote");
  }
  const closeQuote = deployScriptText.indexOf("'", openQuote + 1);
  if (closeQuote < 0) {
    throw new Error("could not find the jq program's closing quote");
  }
  const program = deployScriptText.slice(openQuote + 1, closeQuote);
  // The program must end at the block's closing `')` — if the next
  // characters aren't `)`, an apostrophe crept into the program (which
  // would ALSO break the real deploy, since bash would close the quote
  // there too).
  if (deployScriptText[closeQuote + 1] !== ")") {
    throw new Error(
      "the jq program contains an apostrophe (bash would truncate it exactly like this extractor did) — remove it"
    );
  }
  return program;
}

/**
 * Render the canonical workflow by executing the extracted jq program with
 * representative args (webhookUrl set ⇒ isWebhook tools, hasLocal=true ⇒
 * Local twins enabled — matching a standard-tier provision).
 */
export function renderWorkflowSeed(repoRoot?: string): SeedWorkflow {
  const root = repoRoot ?? process.cwd();
  const shText = fs.readFileSync(path.join(root, DEPLOY_CLIENT_SH), "utf8");
  const program = extractWorkflowJqProgram(shText);
  const stdout = execFileSync(
    "jq",
    [
      "-nc",
      "--arg", "name", "Parity Check",
      "--arg", "instructions", "You are a professional AI coworker.",
      "--arg", "model", "qwen3:4b-instruct",
      "--arg", "ownerModel", "gemini-2.5-flash",
      "--arg", "smsModel", "gemini-2.5-flash",
      "--arg", "hasLocal", "true",
      "--arg", "webhookUrl", "https://app.example.com/api/rowboat/tool-call",
      "--arg", "now", "2026-01-01T00:00:00Z",
      program
    ],
    { encoding: "utf8" }
  );
  return JSON.parse(stdout) as SeedWorkflow;
}
