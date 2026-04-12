import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function loadIntegrationEnvLocal(metaUrl: string): void {
  const configDir = dirname(fileURLToPath(metaUrl));
  const integrationEnvLocal = resolve(configDir, ".env.integration.local");
  if (!existsSync(integrationEnvLocal)) {
    return;
  }

  for (const line of readFileSync(integrationEnvLocal, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}
