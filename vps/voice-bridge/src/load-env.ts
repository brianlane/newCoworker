import { config } from "dotenv";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load `.env` from the bridge directory, then repo root, then default cwd. */
export function loadEnv(): void {
  const bridgeEnv = resolve(__dirname, "../.env");
  const repoRootEnv = resolve(__dirname, "../../../.env");
  if (existsSync(bridgeEnv)) config({ path: bridgeEnv });
  if (existsSync(repoRootEnv)) config({ path: repoRootEnv });
  config();
}
