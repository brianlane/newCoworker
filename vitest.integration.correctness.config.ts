import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { loadIntegrationEnvLocal } from "./vitest.integration.env";
import {
  INTEGRATION_HOOK_TIMEOUT_MS,
  INTEGRATION_TEST_TIMEOUT_MS
} from "./vitest.integration.constants";

loadIntegrationEnvLocal(import.meta.url);

/** Runs only the correctness integration path. */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/integration/kvm-rowboat-correctness.test.ts"],
    fileParallelism: false,
    testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
    hookTimeout: INTEGRATION_HOOK_TIMEOUT_MS,
    coverage: {
      enabled: false
    }
  }
});
