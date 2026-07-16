/**
 * Markdown → PowerPoint export (src/lib/pptx/from-markdown.ts): the pure
 * slide-model builder (headings/bullets/caps), the filename sanitizer, and
 * a real render producing valid .pptx (zip) bytes.
 */
import { describe, expect, it } from "vitest";

import {
  PPTX_MAX_BULLETS_PER_SLIDE,
  PPTX_MAX_CHARS_PER_BULLET,
  PPTX_MAX_SLIDES,
  buildSlideModel,
  pptxFilename,
  renderPptxBuffer
} from "@/lib/pptx/from-markdown";

describe("buildSlideModel", () => {
  it("turns #/## headings into slides and list items into bullets (one nest level)", () => {
    const md = [
      "# Q3 Marketing Plan",
      "Intro paragraph.",
      "## Channels",
      "- **Email** campaigns",
      "  - weekly cadence",
      "1. SMS blasts",
      "### Budget note",
      "| a | b |"
    ].join("\n");
    const deck = buildSlideModel(md, "Q3 Plan.md");
    expect(deck.title).toBe("Q3 Plan.md");
    expect(deck.slides.map((s) => s.title)).toEqual(["Q3 Marketing Plan", "Channels"]);
    expect(deck.slides[0].bullets).toEqual([{ text: "Intro paragraph.", indent: 0 }]);
    expect(deck.slides[1].bullets).toEqual([
      { text: "Email campaigns", indent: 0 },
      { text: "weekly cadence", indent: 1 },
      { text: "SMS blasts", indent: 0 },
      { text: "Budget note", indent: 0 },
      { text: "a · b", indent: 0 }
    ]);
    expect(deck.truncated).toBe(false);
  });

  it("puts pre-heading text on an Overview slide and skips code fences / rules", () => {
    const md = ["Some intro", "```", "# not a slide", "```", "---", "- point"].join("\n");
    const deck = buildSlideModel(md, "Notes");
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0].title).toBe("Overview");
    expect(deck.slides[0].bullets.map((b) => b.text)).toEqual(["Some intro", "point"]);
  });

  it("strips checkbox markers, links, and decoration; blank headings become Untitled", () => {
    const md = ["# [](https://x.test)", "- [ ] call [Jane](https://x.test) about ~~old~~ `code` __plan__"].join("\n");
    const deck = buildSlideModel(md, "");
    expect(deck.title).toBe("Presentation");
    expect(deck.slides[0].title).toBe("Untitled");
    expect(deck.slides[0].bullets[0].text).toBe("call Jane about old code plan");
  });

  it("caps slides, bullets per slide, and bullet length — flagging truncation", () => {
    const manySlides = Array.from({ length: PPTX_MAX_SLIDES + 5 }, (_, i) => `# S${i}`).join("\n");
    const deckA = buildSlideModel(manySlides, "big");
    expect(deckA.slides).toHaveLength(PPTX_MAX_SLIDES);
    expect(deckA.truncated).toBe(true);

    const manyBullets = ["# One", ...Array.from({ length: PPTX_MAX_BULLETS_PER_SLIDE + 4 }, (_, i) => `- b${i}`)].join("\n");
    const deckB = buildSlideModel(manyBullets, "big");
    expect(deckB.slides[0].bullets).toHaveLength(PPTX_MAX_BULLETS_PER_SLIDE);
    expect(deckB.truncated).toBe(true);

    const longBullet = `# One\n- ${"x".repeat(PPTX_MAX_CHARS_PER_BULLET + 50)}`;
    const deckC = buildSlideModel(longBullet, "big");
    expect(deckC.slides[0].bullets[0].text.length).toBe(PPTX_MAX_CHARS_PER_BULLET);
    expect(deckC.truncated).toBe(true);
  });

  it("drops empty bullet lines and handles empty markdown", () => {
    expect(buildSlideModel("- \n-  ", "x").slides).toHaveLength(0);
    // A bullet whose text empties after decoration stripping also drops.
    expect(buildSlideModel("- [](https://x.test)", "x").slides).toHaveLength(0);
    expect(buildSlideModel("", "x").slides).toHaveLength(0);
  });
});

describe("renderPptxBuffer", () => {
  it("produces real .pptx (zip) bytes for a deck", async () => {
    const deck = buildSlideModel("# Hello\n- world\n  - nested", "Demo");
    const bytes = await renderPptxBuffer(deck);
    expect(bytes.length).toBeGreaterThan(1000);
    // .pptx is a zip: PK\x03\x04 magic.
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("renders a deck with an empty-bullet slide (title-only)", async () => {
    const bytes = await renderPptxBuffer({
      title: "T",
      slides: [{ title: "Only a title", bullets: [] }],
      truncated: false
    });
    expect(bytes[0]).toBe(0x50);
  });
});

describe("pptxFilename", () => {
  it("sanitizes and caps, with a fallback for degenerate titles", () => {
    expect(pptxFilename("Q3 Plan: Draft #2")).toBe("Q3_Plan_Draft_2.pptx");
    expect(pptxFilename("///")).toBe("presentation.pptx");
    expect(pptxFilename("a".repeat(200))).toBe(`${"a".repeat(80)}.pptx`);
  });
});
