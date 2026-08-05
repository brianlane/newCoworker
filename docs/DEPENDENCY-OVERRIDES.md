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

## Current overrides

| Override | Introduced | Reason | Status (Aug 2026) |
| --- | --- | --- | --- |
| `@hono/node-server: ^2.0.5` | PR #825 (Jul 21, 2026) | Dependabot alert #37: path traversal in `serve-static` on Windows (moderate). Transitive under `@modelcontextprotocol/sdk`, which declared `^1.19.9` with no patched 1.x available. | **Orphaned.** The SDK was removed in PR #1181; nothing requests this package now. Kept as a safety pin; safe to delete if it blocks something. |
| `axios: ^1.18.1` | Apr 2026 (pre-PR-flow commit `ec2625da`, bumped since) | `@nangohq/node` and `@nangohq/types` pin axios exactly (currently `1.18.0`); the override forces the patched line when advisories land faster than Nango releases. | **Live.** Matches the Nango-pinned copy. |
| `fast-uri: ^3.1.5` | PR #809 (Jul 21, 2026, rider on the Gemini model migration) | GHSA-v2hh-gcrm-f6hx: host-confusion advisory, reached through `ajv` 8.x chains. | **Orphaned.** Both `ajv` chains that pulled it arrived via `@modelcontextprotocol/sdk` (removed in #1181). Kept as a safety pin: any future dep using `ajv` 8.x would re-pull it. |
| `ip-address: ^10.4.0` | PR #1144 (Aug 3, 2026) | GHSA-mwp4-54f8-5fhr (high) plus two related advisories: parse bugs that defeat SSRF and trust-boundary checks. Reached through `express-rate-limit`. Note: our own SSRF protection is `src/lib/net/ip-classification.ts` and never used this package. | **Orphaned.** `express-rate-limit` came only via `@modelcontextprotocol/sdk` (removed in #1181). Kept as a safety pin given the advisory severity. |
| `postcss: ^8.5.18` | PR #217 (Jun 18, 2026, originally `>=8.5.10`) | Moderate parsing advisory; the override dedupes Next.js's nested older copy onto the patched version. | **Live.** Matches copies requested by `next`, `@tailwindcss/postcss`, `sanitize-html`, and `vite`. |
| `sharp: ^0.35.3` | PR #812 (Jul 21, 2026) | GHSA-f88m-g3jw-g9cj: libvips advisory. `next` optionally pins a vulnerable range. | **Live.** Matches `next`'s optional dependency. |

## Rules of thumb

- Prefer an override over waiting on an upstream release only when the
  advisory is live in our tree and the owning package has no patched release
  we can adopt directly (same rule as the sub-tree guidance in
  `.github/workflows/audit.yml`).
- When the last requester of an overridden package leaves the tree, mark the
  row **Orphaned** here rather than deleting the pin, unless the pin itself
  starts causing ERESOLVE conflicts.
- The VPS, Cloudflare, and Zapier sub-trees carry their own `overrides` in
  their own `package.json` files; this file covers the root tree only.
