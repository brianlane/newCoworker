---
name: project-next-build-skips-test-typecheck
description: npm run build typechecks src but not tests, so a green build can hide a type error CI will catch
metadata:
  type: project
---

`next build` runs TypeScript over the app, not over `tests/`. A local run of
tsc, eslint, vitest AND build can all be green while `tests/*.ts` has a type
error that the CI Typecheck job then fails on (hit Aug 2026 on PR #1302: a
const-asserted union passed to `Set.has`).

Run `npx tsc --noEmit` **last**, after editing tests, not before. Vitest does
not typecheck either, so passing tests prove nothing here.

Same family as [[project-worktree-build-needs-real-node-modules]]: the local
signal is narrower than it looks.
