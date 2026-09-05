# Root `package.json` overrides: why each pin exists

`package.json` cannot hold comments, so the reasons live here. Keep this file
in step with the `overrides` block: when you add, change, or remove an
override, update the matching row in the same PR. The point is that "can this
pin come out?" should be a lookup, not an investigation. (PR #1181 spent real
effort reverse-engineering three of these from lockfile history; this file
exists so nobody does that again.)

An override that matches nothing is inert: npm applies it only when some
dependency tree actually requests the package. Keeping an orphaned pin is
cheap insurance that a future dependency reintroducing the package lands on a
safe version instead of silently reopening a fixed advisory.

When the overridden package is ALSO a direct dependency, the override MUST
be the `$name` form (`"postcss": "$postcss"`), not a second copy of the
version range. npm rejects a literal override whose spec does not match the
direct dep exactly (`EOVERRIDE`), and Dependabot hits that on every bump:
it rewrites the override to the new exact version while leaving the direct
range alone, then the updater job on main fails with "Override for
X@Y conflicts with direct dependency." The `$name` form keeps nested copies
on the direct pin and lets Dependabot bump only the direct entry. A CI
guard in `tests/dependency-overrides.test.ts` fails the PR if a dual-listed
pin regresses to a literal.

## Current overrides

| Override | Introduced | Reason | Status (Aug 2026) |
| --- | --- | --- | --- |
| `@hono/node-server: ^2.0.5` | PR #825 (Jul 21, 2026) | Dependabot alert #37: path traversal in `serve-static` on Windows (moderate). Transitive under `@modelcontextprotocol/sdk`, which declared `^1.19.9` with no patched 1.x available. | **Orphaned.** The SDK was removed in PR #1181; nothing requests this package now. Kept as a safety pin; safe to delete if it blocks something. |
| `axios: $axios` | Apr 2026 (pre-PR-flow commit `ec2625da`, bumped since; `$name` form Sep 2026) | `@nangohq/node` and `@nangohq/types` pin axios exactly (currently `1.18.0`); the override forces the patched line when advisories land faster than Nango releases. Direct pin is `^1.20.0`. | **Live.** Nested copies follow the direct dep. |
| `fast-uri: ^3.1.5` | PR #809 (Jul 21, 2026, rider on the Gemini model migration) | GHSA-v2hh-gcrm-f6hx: host-confusion advisory, reached through `ajv` 8.x chains. | **Orphaned.** Both `ajv` chains that pulled it arrived via `@modelcontextprotocol/sdk` (removed in #1181). Kept as a safety pin: any future dep using `ajv` 8.x would re-pull it. |
| `ip-address: ^10.4.0` | PR #1144 (Aug 3, 2026) | GHSA-mwp4-54f8-5fhr (high) plus two related advisories: parse bugs that defeat SSRF and trust-boundary checks. Reached through `express-rate-limit`. Note: our own SSRF protection is `src/lib/net/ip-classification.ts` and never used this package. | **Orphaned.** `express-rate-limit` came only via `@modelcontextprotocol/sdk` (removed in #1181). Kept as a safety pin given the advisory severity. |
| `postcss: $postcss` | PR #217 (Jun 18, 2026, originally `>=8.5.10`; `$name` form Sep 2026) | Moderate parsing advisory; the override dedupes Next.js's nested older copy onto the patched version. Direct pin is `^8.5.26`. | **Live.** Nested copies follow the direct dep (`next`, `@tailwindcss/postcss`, `sanitize-html`, `vite`). |
| `sharp: $sharp` | PR #812 (Jul 21, 2026; `$name` form Sep 2026) | GHSA-f88m-g3jw-g9cj: libvips advisory. `next` optionally pins a vulnerable range (16.3.4 requires `^0.35.4` for AVIF). Direct pin is `^0.35.4`. | **Live.** Nested copies follow the direct dep. |

## Rules of thumb

- Prefer an override over waiting on an upstream release only when the
  advisory is live in our tree and the owning package has no patched release
  we can adopt directly (same rule as the sub-tree guidance in
  `.github/workflows/audit.yml`).
- If the package is also a direct dependency, write `"foo": "$foo"`, never a
  second copy of the version range. Literal dual-listing is what failed the
  Dependabot updater on 2026-09-05 (postcss 8.5.26, axios 1.20.0, sharp
  0.35.4).
- When the last requester of an overridden package leaves the tree, mark the
  row **Orphaned** here rather than deleting the pin, unless the pin itself
  starts causing ERESOLVE conflicts.
## Sub-tree overrides

The sub-trees carry their own `overrides` in their own `package.json` files.
Same rules as the root: an override is a ceiling that needs raising, not a
fix that stays fixed, and each one exists for an advisory that was live in
that tree when pinned (the audit matrix in `.github/workflows/audit.yml`
audits every tree the way CI does, dev deps included).

### `zapier/` (published integration; pins ride `zapier-platform-cli`'s tree)

| Package | Pin | Why |
| --- | --- | --- |
| `adm-zip` | `>=0.6.0` | GHSA-xcpc-8h2w-3j85 (crafted ZIP memory blowup); CLI pinned 0.5.x exactly (July audit M1) |
| `brace-expansion` | `>=5.0.9` | GHSA-rgw5-rvv9-x895 ReDoS; raised past the previously-pinned vulnerable floor |
| `form-data` | `>=4.0.6` | advisory floor, transitive via the CLI |
| `tar` | `>=7.5.21` | advisory floor, transitive via the CLI |
| `tmp` | `>=0.2.6` | advisory floor, transitive via the CLI |
| `sigstore` / `@sigstore/core` | `>=4.1.1` / `>=3.2.1` | advisory floors in the CLI's publish chain |
| `yeoman-environment` | `>=6.0.1` | advisory floor, transitive via the CLI |
| `minimatch` | `>=10.0.3` | ReDoS-class advisory floor |
| `ip-address` | `^10.4.0` | same advisory as the root/aiflow-render pins (the #1140-#1142 Dependabot deadlock trio); our SSRF guard does not use this package |

### `cloudflare/email-worker/`

| Package | Pin | Why |
| --- | --- | --- |
| `sharp` | `^0.35.3` | advisory floor in the attachment-processing chain |
| `undici` | `^7.29.0` | GHSA-8xcm-r25x-g524 / GHSA-4cwx-7wf7-3272; CARET deliberately, not `>=` (an unbounded `>=` once resolved to a v8 major the tooling did not expect) |

### `vps/aiflow-render/`

| Package | Pin | Why |
| --- | --- | --- |
| `ip-address` | `^10.4.0` | same advisory family as the zapier/root pins |
