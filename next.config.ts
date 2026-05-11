import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: projectRoot
  },
  // `ssh2` pulls in native/optional deps (e.g. `cpu-features`) and ships a
  // `crypto.js` file that Turbopack cannot statically analyse for ESM. It must
  // stay as a runtime `require()` on the server — it is only reached from
  // server-only routes (orchestrator / provisioning), never from the browser.
  serverExternalPackages: ["ssh2"]
};

export default nextConfig;
