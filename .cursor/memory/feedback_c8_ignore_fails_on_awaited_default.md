---
name: c8-ignore-fails-on-awaited-default
description: "/* c8 ignore */ does not take on `const db = client ?? (await createSupabaseServiceClient())`; mock the module and test the default instead"
metadata:
  type: feedback
---

The repo's usual escape hatch for an injected-dep default,
`/* c8 ignore next */` above `const x = deps.y ?? productionY;`, works for
plain expressions but NOT when the right-hand side contains an `await`:

```ts
/* c8 ignore start */
const db = client ?? (await createSupabaseServiceClient());  // still counted
/* c8 ignore stop */
```

v8 keeps reporting the line uncovered (seen on
`src/lib/owner-surfaces/staff-mode.ts`, 2026-08-26), so the 100% gate on
`src/lib/**` fails.

**Why:** the ignore comment covers the statement, but the awaited
continuation is attributed separately.

**It is worse than "the ignore does nothing": the ignore MOVES the gap onto
the NEXT statement** (confirmed 2026-08-28 on
`src/lib/analytics/growth-report.ts`). With `/* c8 ignore next */` above the
awaited default, v8 reported the following line, an ordinary
`const now = opts.now ?? new Date();`, as uncovered instead. Both `next` and
`start`/`stop` did it. So the symptom is a mystery gap on an innocent line one
below, and chasing THAT line with more tests never closes it. If a
plainly-executed line reports uncovered, look at the statement above it for an
awaited default.

**How to apply:** stop annotating and cover it. `vi.mock` the module and add
one test that calls the function WITHOUT the client argument:

```ts
let serviceDb: unknown = null;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => serviceDb)
}));
```

Better test anyway: production takes that branch on every call, so it was
the one path never exercised. Adding that one test closed both the awaited
line AND the phantom gap below it. Related: [[feedback-testing]].
