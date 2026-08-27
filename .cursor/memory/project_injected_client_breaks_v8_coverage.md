---
name: injected-client-breaks-v8-coverage
description: Passing a test client to a fn using `client ?? await createSupabaseServiceClient()` makes v8 report every later statement uncovered
metadata:
  type: project
---

Most `src/lib/db` helpers start with:

```ts
const db = client ?? (await createSupabaseServiceClient());
```

If a test passes `client` explicitly, that `await` never runs. v8 treats the
code after an await as a separate continuation range, so it reports **every
statement in the rest of the function as uncovered**, even though the test
executed all of it and passed. The failure looks like real missing coverage on
correct code, and chasing it through mock rewrites, restructured awaits, and
`c8 ignore` gets nowhere.

**Fix:** do what the offers/intake attach tests do. Mock
`createSupabaseServiceClient` to resolve your stub and call the function with
NO client argument. Keep one test that passes a client explicitly, to cover the
left side of the `??`.

Found Aug 18 2026 in PR #1458.

Second trap from the same PR: a test helper named `useDb` trips eslint's
`react-hooks/rules-of-hooks` ("may be executed more than once") when called in
a loop, because of the `use*` prefix. Name test helpers `withDb`, not `useDb`.

Related: [[full-test-coverage-requirement]].
