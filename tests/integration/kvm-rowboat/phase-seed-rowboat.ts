import { isKvm8ComposeFile, waitForRowboatHttpOk, type KvmStack } from "../kvm-stack-helpers";
import { seedMongoDb, restartRowboatAfterSeed } from "./mongo-seed";
import { warmupOllamaViaHostApi } from "./warmup";

export async function runMongoSeedAndRowboatReadyPhase(stack: KvmStack, model: string): Promise<void> {
  console.log(`[integration] ${stack.label} phase: seed Mongo + restart Rowboat + wait HTTP`);
  seedMongoDb(stack.composeFile, model);
  restartRowboatAfterSeed(stack.composeFile, model);
  await waitForRowboatHttpOk(stack.ports.rowboat);

  if (!isKvm8ComposeFile(stack.composeFile)) {
    console.log(`[integration] ${stack.label} phase: host /api/generate warmup (starter stack)`);
    await warmupOllamaViaHostApi(stack.ports.ollama, model);
  }
}
