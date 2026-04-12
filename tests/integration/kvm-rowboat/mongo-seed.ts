import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { dockerCompose, repoRoot } from "../kvm-stack-helpers";
import { INTEGRATION_ROWBOAT_API_KEY, INTEGRATION_ROWBOAT_PROJECT_ID } from "./constants";

function buildRowboatWorkflow(ollamaModelTag: string) {
  const lastUpdatedAt = new Date().toISOString();
  return {
    agents: [
      {
        name: "IntegrationAssistant",
        type: "conversation",
        description: "Integration test assistant for SMS-style real estate scenarios.",
        disabled: false,
        instructions:
          "You are a professional real estate assistant. Keep replies short and helpful.\n" +
          "When a buyer asks if a listing is still available after the seller accepted another offer, explain the home may be under contract and backup offers may be considered.\n" +
          "When someone asks to schedule a showing, acknowledge and ask for preferred times.\n" +
          "Fair Housing Act: never steer or filter by protected classes; use objective property criteria only; offer equal professional service.",
        model: ollamaModelTag,
        outputVisibility: "user_facing",
        controlType: "retain",
        ragK: 3,
        ragReturnType: "chunks"
      }
    ],
    prompts: [
      {
        name: "baseline",
        type: "base_prompt",
        prompt: "Integration test project."
      }
    ],
    tools: [] as unknown[],
    startAgent: "IntegrationAssistant",
    lastUpdatedAt
  };
}

export function seedMongoDb(composeFile: string, ollamaModelTag: string) {
  const workflow = buildRowboatWorkflow(ollamaModelTag);
  const now = new Date().toISOString();
  const projectDoc = {
    _id: INTEGRATION_ROWBOAT_PROJECT_ID,
    name: "Integration Bot Test",
    createdAt: now,
    createdByUserId: "integration-user",
    secret: "integration-test-secret",
    draftWorkflow: workflow,
    liveWorkflow: workflow
  };
  const keyDoc = {
    projectId: INTEGRATION_ROWBOAT_PROJECT_ID,
    key: INTEGRATION_ROWBOAT_API_KEY,
    createdAt: now
  };
  const script = `
db.api_keys.deleteMany({ projectId: "${INTEGRATION_ROWBOAT_PROJECT_ID}" });
db.projects.deleteMany({ _id: "${INTEGRATION_ROWBOAT_PROJECT_ID}" });
db.projects.insertOne(${JSON.stringify(projectDoc)});
db.api_keys.insertOne(${JSON.stringify(keyDoc)});
`;
  const tmp = join(tmpdir(), `rowboat-seed-${Date.now()}.js`);
  writeFileSync(tmp, script, "utf8");
  try {
    execFileSync("docker", ["compose", "-f", composeFile, "cp", tmp, "mongo:/tmp/rowboat.seed.js"], {
      cwd: repoRoot,
      stdio: "inherit"
    });
    execFileSync(
      "docker",
      ["compose", "-f", composeFile, "exec", "-T", "mongo", "mongosh", "rowboat", "/tmp/rowboat.seed.js"],
      { cwd: repoRoot, stdio: "inherit" }
    );
  } finally {
    unlinkSync(tmp);
  }
  const countOut = execFileSync(
    "docker",
    [
      "compose",
      "-f",
      composeFile,
      "exec",
      "-T",
      "mongo",
      "mongosh",
      "rowboat",
      "--quiet",
      "--eval",
      "JSON.stringify({ projects: db.projects.countDocuments({_id: '00000000-0000-4000-8000-000000000001'}), keys: db.api_keys.countDocuments({ projectId: '00000000-0000-4000-8000-000000000001' }) })"
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );
  const parsed = JSON.parse(countOut.trim()) as { projects: number; keys: number };
  if (parsed.projects !== 1 || parsed.keys !== 1) {
    throw new Error(`Mongo seed verification failed: ${countOut.trim()}`);
  }
}

export function restartRowboatAfterSeed(composeFile: string, ollamaModel: string) {
  dockerCompose(composeFile, ["restart", "rowboat"], ollamaModel);
}
