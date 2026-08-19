import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A "use client" component must not import a VALUE from a module that reaches
 * the Supabase server client, because that reaches `next/headers`, which
 * cannot exist in a browser bundle. Turbopack fails the build with an
 * "Ecmascript file had an error" pointing at src/lib/supabase/server.ts and an
 * import trace that names routes and layouts rather than the component that
 * actually caused it, so the message sends you looking in the wrong place.
 *
 * It is easy to hit by accident: the offending import can look completely
 * innocent. The browse-step "Try these actions" panel imported two string
 * helpers from `action-check.ts`, which imports the URL guard from
 * `page-probe.ts`, which imports `custom-integrations.ts` for
 * `isPrivateOrLoopbackHost`, which imports the server client. Four hops from a
 * function that returns a sentence.
 *
 * The fix is always the same, and there is precedent in the repo
 * (browse-action-tree.ts beside browse-action-steps.ts): put the client-safe
 * half in its own module. This test walks the dashboard components and fails
 * before the build does, naming the component and the chain.
 */

const ROOT = join(__dirname, "..");
const COMPONENTS = join(ROOT, "src/components/dashboard");
const LIB = join(ROOT, "src/lib");

/**
 * Modules that cannot appear in a browser bundle at all.
 *
 * `@supabase/ssr` is deliberately NOT here: it exports the browser client too
 * (src/lib/supabase/browser.ts uses `createBrowserClient` legitimately), so
 * listing it would flag correct code. `next/headers` is the import that
 * actually breaks the build, via `cookies()` in the server client.
 */
const SERVER_ONLY = ["next/headers", "server-only", "node:fs", "node:crypto", "node:child_process"];

/** Resolve an `@/lib/...` specifier to a file path, or null. */
function resolveLib(spec: string): string | null {
  if (!spec.startsWith("@/lib/")) return null;
  const base = join(LIB, spec.slice("@/lib/".length));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Not this shape; try the next.
    }
  }
  return null;
}

/**
 * Specifiers imported for their VALUES. `import type` is erased by the
 * compiler and never reaches the bundle, so a type-only import of a
 * server-reaching module is fine and must not be flagged.
 */
function valueImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/import\s+([\s\S]*?)\s*from\s*["']([^"']+)["']/g)) {
    const clause = m[1];
    if (/^\s*type\s/.test(clause)) continue;
    // A clause whose every named binding is `type X` is also erased.
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named && !/(^|,)\s*(?!type\s)[A-Za-z_$]/.test(named[1]) && !/^\s*\w+\s*,/.test(clause)) {
      continue;
    }
    out.push(m[2]);
  }
  return out;
}

/** Walk a module's value imports, returning the first server-only hop found. */
function serverChain(entry: string, seen = new Set<string>()): string[] | null {
  if (seen.has(entry)) return null;
  seen.add(entry);
  let source: string;
  try {
    source = readFileSync(entry, "utf8");
  } catch {
    return null;
  }
  for (const spec of valueImports(source)) {
    if (SERVER_ONLY.includes(spec)) return [entry, spec];
    const next = resolveLib(spec);
    if (!next) continue;
    const deeper = serverChain(next, seen);
    if (deeper) return [entry, ...deeper];
  }
  return null;
}

function clientComponents(): string[] {
  return readdirSync(COMPONENTS)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join(COMPONENTS, f))
    .filter((p) => readFileSync(p, "utf8").trimStart().startsWith('"use client"'));
}

describe("dashboard client components stay out of the server bundle", () => {
  const components = clientComponents();

  it("finds client components to check, so the sweep is not vacuous", () => {
    expect(components.length).toBeGreaterThan(5);
  });

  it.each(components.map((p) => [p.slice(ROOT.length + 1), p]))(
    "%s imports no server-only module",
    (_name, path) => {
      const chain = serverChain(path);
      expect(
        chain,
        chain
          ? `reaches a server-only module through:\n  ${chain
              .map((p) => (p.startsWith("/") ? p.slice(ROOT.length + 1) : p))
              .join("\n  -> ")}\nMove the client-safe half into its own module (see action-check-view.ts).`
          : ""
      ).toBeNull();
    }
  );
});
