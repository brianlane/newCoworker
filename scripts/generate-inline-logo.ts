#!/usr/bin/env tsx
/**
 * Generates `src/app/inline-logo.ts`: the brand mark, shrunk and base64'd, so
 * the 404 page can render it without a second network request.
 *
 * Why this exists. `src/app/not-found.tsx` used to render the logo through
 * `next/image`. That turned one bot request for a junk URL into three billable
 * edge requests: the page itself, `/_next/image` for the optimized logo, and
 * (on an optimizer cache miss) the source fetch of `/logo.png`, which the
 * `beforeFiles` rewrite in `next.config.ts` sends to `/api/brand-logo`. The
 * Aug 3 2026 usage-anomaly alert showed exactly that shape: 1.7K hits on
 * `/_not-found` dragging 509 `/_next/image` and 304 `/api/brand-logo` along
 * behind them. Inlining the bytes collapses all of it to one request.
 *
 * Why a generated TypeScript constant and not `readFileSync` at runtime, which
 * is what `/api/brand-logo` and `opengraph-image.tsx` both do: those two are
 * allowed to fail loudly, but the 404 page is the surface you least want to
 * break, and a runtime disk read needs an `outputFileTracingIncludes` entry to
 * survive bundling (see the one already there for `/api/brand-logo`). A string
 * baked into the bundle has no such failure mode.
 *
 * The transform: downscale to 96px (2x the 48px display box, so it stays crisp
 * on retina), median-filter, then quantise to a 16-colour palette. The source
 * is flat vector-style art carrying heavy film grain, and that grain is what
 * makes `public/logo.png` large; at 96px it is invisible, so removing it costs
 * nothing and buys most of the size. Do NOT reuse this recipe on the full-size
 * asset: at 500px the median filter visibly chews the anti-aliased edges.
 *
 * Usage:
 *   npx tsx scripts/generate-inline-logo.ts
 *
 * Re-run it whenever `public/logo.png` changes. `tests/inline-logo.test.ts`
 * fails if you forget, comparing the committed constant back against the
 * current source art.
 *
 * Related, and deliberately NOT automated here: `public/logo.png` itself was
 * re-encoded once (309,357 -> 115,729 bytes) with
 * `sharp(src).removeAlpha().png({ palette: true, colors: 256, effort: 10 })`.
 * That is a lossless-looking requantisation of the same artwork, not a
 * redesign: no resize and no denoise, so every edge is untouched. It is a
 * source asset, so it lives in git as bytes rather than being rebuilt here.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/** 2x the 48px box the 404 renders it in. */
const INTRINSIC_PX = 96;

// The package is ESM ("type": "module"), so there is no __dirname. Anchoring
// on this file rather than cwd keeps the script runnable from any directory.
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(repoRoot, "public", "logo.png");
const TARGET = path.join(repoRoot, "src", "app", "inline-logo.ts");

async function main(): Promise<void> {
  const png = await sharp(readFileSync(SOURCE))
    .resize(INTRINSIC_PX, INTRINSIC_PX, { kernel: "lanczos3" })
    .median(3)
    // The source's alpha channel is fully opaque, so dropping it loses
    // nothing. The round crop on screen is CSS (`rounded-full`), not alpha.
    .removeAlpha()
    // 8 colours, not more: the mark is three flat tones plus anti-aliasing, and
    // the quantiser's own choices make 12 and 16 land on 1,816 bytes while 8
    // lands on 674 for no visible difference at this size. Measured, not
    // assumed; re-measure if the artwork ever changes.
    .png({ palette: true, colors: 8, effort: 10 })
    .toBuffer();

  const dataUri = `data:image/png;base64,${png.toString("base64")}`;

  writeFileSync(
    TARGET,
    `// GENERATED FILE. Do not edit by hand.
// Regenerate with: npx tsx scripts/generate-inline-logo.ts
// Source: public/logo.png. See that script for why the 404 inlines its logo.

/** Intrinsic pixel width/height of the encoded image. */
export const INLINE_LOGO_PX = ${INTRINSIC_PX};

/** The brand mark as a self-contained data URI, so rendering it costs no request. */
export const INLINE_LOGO_DATA_URI =
  "${dataUri}";
`,
    "utf8"
  );

  console.log(
    `wrote ${path.relative(repoRoot, TARGET)}: ${png.length} bytes of PNG, ` +
      `${dataUri.length} chars of data URI`
  );
}

void main();
