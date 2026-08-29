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
  },
  {
    /**
     * public/sw.js has the exact shape the vps block above exists for: plain
     * script, no build step, no typechecker, shipped byte-for-byte to the
     * browser. It is worse in one way. A VPS sidecar that references a
     * deleted name throws on the first request and someone notices within
     * minutes; a service worker that does throws inside a push event, on a
     * device we do not own, and the only symptom is that an urgent alert
     * silently never arrived.
     *
     * `npx eslint --print-config public/widget.js` confirms the defaults are
     * not enough on their own: no-undef is OFF for public/*.js, and the
     * resolved globals are browser-only, so `clients`, `registration` and
     * `ServiceWorkerGlobalScope` would all read as undefined names.
     *
     * sourceType is "script" because the worker is registered as a classic
     * script. That is not cosmetic either: it makes a stray `import` a lint
     * error here instead of a runtime SyntaxError that silently unregisters
     * the worker in the field.
     */
    files: ["public/sw.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.serviceworker }
    },
    rules: { "no-undef": "error" }
  }
];

export default config;
