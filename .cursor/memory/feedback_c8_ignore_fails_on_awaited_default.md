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

**How to apply:** stop annotating and cover it. `vi.mock` the module and add
one test that calls the function WITHOUT the client argument:

```ts
let serviceDb: unknown = null;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => serviceDb)
}));
```

Better test anyway: production takes that branch on every call, so it was
the one path never exercised. Related: [[feedback-testing]].
