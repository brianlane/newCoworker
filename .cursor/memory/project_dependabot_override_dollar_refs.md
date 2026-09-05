---
name: dependabot-override-dollar-refs
description: Dual-listed npm overrides (direct dep + literal version pin) fail the Dependabot updater with EOVERRIDE; use $name refs
metadata:
  node_type: memory
  type: project
  modified: 2026-09-05T03:15:00.000Z
---

On 2026-09-05 the Dependabot updater job on main failed (check name
`Dependabot`, run title `npm_and_yarn in / for lucide-react, next, ...`)
with three `dependency_file_not_resolvable` errors:

- Override for postcss@8.5.26 conflicts with direct dependency
- Override for axios@1.20.0 conflicts with direct dependency
- Override for sharp@0.35.4 conflicts with direct dependency

Product CI on that commit stayed green. Dependabot still opened the grouped
minor/patch PR for the packages it could bump; it could not land those three.

**Why:** `package.json` listed each package as a direct dependency AND as a
literal `overrides` pin with the same caret range. npm forbids that unless
the two strings match exactly. Dependabot rewrites the override to the new
exact version and leaves the direct range, so `npm install` fails with
`EOVERRIDE`. The documented npm idiom is `"foo": "$foo"`: nested copies
follow the direct pin, and Dependabot only bumps the direct entry.

**How to apply:** If a package is both a direct dep and an override, write
`"foo": "$foo"`. Keep literal version pins for packages that are NOT
direct deps (orphaned safety pins, sub-tree pins). Raise the direct floor
when the missed bump is a real patch. `docs/DEPENDENCY-OVERRIDES.md` and
`tests/dependency-overrides.test.ts` must stay in step. Do not delete the
override: without it, Next.js / Nango nested copies can stay on the
vulnerable range.
