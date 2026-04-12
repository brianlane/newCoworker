import {
  dockerCompose,
  assertHeartbeatCurlLikeHeartbeatScript,
  ollamaPull,
  assertOllamaOpenAiChat,
  type KvmStack,
  OLLAMA_CHAT_TIMEOUT_SEC
} from "../kvm-stack-helpers";

/**
 * Minimal stack bring-up for correctness: one Ollama image and one `/v1/chat/completions` sanity check.
 *
 * @param model Ollama tag for this run. Use `INTEGRATION_CORRECTNESS_MODEL_SEQUENCE` for sequential kvm2 comparisons.
 */
export async function runCorrectnessStackLifecyclePhase(stack: KvmStack, model = stack.ollamaModel): Promise<void> {
  console.log(`[integration correctness] ${stack.label} compose up --wait`);
  dockerCompose(stack.composeFile, ["up", "-d", "--wait"], model);
  console.log(`[integration correctness] ${stack.label} heartbeat`);
  assertHeartbeatCurlLikeHeartbeatScript(stack.ports);

  console.log(`[integration correctness] ${stack.label} ollama pull ${model}`);
  ollamaPull(stack.composeFile, model, model);

  console.log(
    `[integration correctness] ${stack.label} Ollama sanity (single /v1/chat probe, timeout ${OLLAMA_CHAT_TIMEOUT_SEC}s)`
  );
  await assertOllamaOpenAiChat(stack.ports.ollama, model, {
    composeFile: stack.composeFile,
    ollamaModel: model,
    label: "correctness single Ollama probe"
  });
}
