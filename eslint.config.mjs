import nextVitals from "eslint-config-next/core-web-vitals";
import globals from "globals";

const config = [
  { ignores: ["coverage/**", ".next/**", "node_modules/**", "**/*.d.mts", "cloudflare/**"] },
  ...nextVitals,
  {
    /**
     * The VPS sidecars ship as plain ESM with no build step and no
     * typechecker, so nothing here catches a reference to a name that does
     * not exist. `node --check` validates syntax only: it parses a file that
     * calls a deleted function perfectly happily, and the container then
     * binds its port and throws ReferenceError on the first request.
     *
     * That is not hypothetical. Splitting filters.mjs out of the data-api's
     * server.mjs deleted `pool`, `bearerOk` and `clientError` along with the
     * code being moved; syntax check passed, the full test suite passed, and
     * only review caught it. no-undef is the rule that would have.
     */
    files: ["vps/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node }
    },
    rules: { "no-undef": "error" }
  }
];

export default config;
