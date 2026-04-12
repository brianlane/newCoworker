/**
 * Correctness job: stack bring-up + Rowboat chat JSON shape for each SMS scenario.
 * Full assistant text per turn is written to `test-results/integration-correctness-responses.json`.
 *
 * `npm run test:integration:correctness` runs kvm8 only (`INTEGRATION_SKIP_KVM2=1`) with
 * default `qwen3:4b-instruct` unless overridden.
 *
 * `npm run test:integration:correctness:kvm2-llama32-compare` runs kvm2 only and compares
 * multiple starter tags in sequence via `INTEGRATION_CORRECTNESS_MODEL_SEQUENCE`.
 */
import { describe, it } from "vitest";
import {
  integrationKvmStacks,
  dockerComposeDown,
  logIntegrationTierFailureDiagnostics,
  resolveCorrectnessModelsForStack
} from "./kvm-stack-helpers";
import { runCorrectnessStackLifecyclePhase } from "./kvm-rowboat/phase-correctness-lifecycle";
import { runMongoSeedAndRowboatReadyPhase } from "./kvm-rowboat/phase-seed-rowboat";
import { runCorrectnessSmsPhase } from "./kvm-rowboat/phase-correctness-sms";
import {
  buildCorrectnessResponsesShell,
  writeIntegrationCorrectnessResponsesFile,
  INTEGRATION_CORRECTNESS_RESPONSES_BASENAME
} from "./kvm-rowboat/correctness-responses-io";

describe("KVM Rowboat correctness (HTTP + JSON shape; kvm8 default `qwen3:4b-instruct` via npm script)", () => {
  it(
    "each enabled stack: Ollama sanity + Rowboat /chat shape for all SMS scenarios",
    async () => {
      const responsesDoc = buildCorrectnessResponsesShell();
      for (const stack of integrationKvmStacks()) {
        const models = resolveCorrectnessModelsForStack(stack);
        for (let mi = 0; mi < models.length; mi++) {
          const model = models[mi]!;
          const runLabel = models.length > 1 ? `${stack.label} [${mi + 1}/${models.length} ${model}]` : stack.label;
          try {
            await runCorrectnessStackLifecyclePhase(stack, model);
            await runMongoSeedAndRowboatReadyPhase(stack, model);
            const scenarios = await runCorrectnessSmsPhase(stack, model);
            responsesDoc.stacks.push({
              label: models.length > 1 ? `${stack.label}::${model}` : stack.label,
              model,
              composeFile: stack.composeFile,
              scenarios
            });
            responsesDoc.generatedAt = new Date().toISOString();
            writeIntegrationCorrectnessResponsesFile(responsesDoc);
            console.log(
              `[integration correctness] ${runLabel} OK — appended to test-results/${INTEGRATION_CORRECTNESS_RESPONSES_BASENAME}`
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[integration correctness] ${runLabel} FAILED: ${msg}`);
            logIntegrationTierFailureDiagnostics(stack.composeFile, model, runLabel);
            throw e;
          } finally {
            dockerComposeDown(stack.composeFile, model);
          }
        }
      }
    },
    /** Single correctness path only: real stack bring-up plus multi-turn Rowboat chat checks. */
    3_600_000
  );
});
