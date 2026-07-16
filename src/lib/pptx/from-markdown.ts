/**
 * Markdown → PowerPoint export.
 *
 * The platform's generated artifacts (dashboard-chat outlines, Agent run
 * outputs, knowledge documents) are markdown; this module turns that
 * markdown into a real .pptx so "build me a presentation" ends in a file
 * PowerPoint/Keynote/Slides can open — not a wall of text to re-type.
 *
 * Split in two for testability:
 *   - `buildSlideModel` (pure): markdown → a bounded slide model. `#`/`##`
 *     headings start slides; `-`/`*`/`1.` lines become bullets (one nesting
 *     level kept); other paragraphs become body lines; text before any
 *     heading lands on an intro slide. Everything is capped so a
 *     pathological document can't mint a 5,000-slide deck.
 *   - `renderPptxBuffer`: slide model → .pptx bytes via pptxgenjs.
 */

import PptxGenJS from "pptxgenjs";

/** Deck-wide caps — an export is a convenience, not a data dump. */
export const PPTX_MAX_SLIDES = 30;
export const PPTX_MAX_BULLETS_PER_SLIDE = 12;
export const PPTX_MAX_CHARS_PER_BULLET = 300;
export const PPTX_MAX_TITLE_CHARS = 120;

export type SlideBullet = {
  text: string;
  /** 0 = top level, 1 = nested. */
  indent: 0 | 1;
};

export type Slide = {
  title: string;
  bullets: SlideBullet[];
};

export type SlideDeck = {
  /** Deck title (title slide) — the document/agent-artifact name. */
  title: string;
  slides: Slide[];
  /** True when slide/bullet caps trimmed content. */
  truncated: boolean;
};

/** Strip inline markdown decoration (bold/italic/code/links) for slide text. */
function plainText(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

export function buildSlideModel(markdown: string, deckTitle: string): SlideDeck {
  const title = plainText(deckTitle).slice(0, PPTX_MAX_TITLE_CHARS) || "Presentation";
  const slides: Slide[] = [];
  let truncated = false;
  let current: Slide | null = null;
  let inCodeFence = false;

  const pushBullet = (text: string, indent: 0 | 1) => {
    if (!current) {
      current = { title: "Overview", bullets: [] };
      slides.push(current);
    }
    if (current.bullets.length >= PPTX_MAX_BULLETS_PER_SLIDE) {
      truncated = true;
      return;
    }
    const clipped = text.slice(0, PPTX_MAX_CHARS_PER_BULLET);
    if (clipped.length < text.length) truncated = true;
    current.bullets.push({ text: clipped, indent });
  };

  for (const raw of markdown.split(/\r\n?|\n/)) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    const trimmed = line.trim();
    if (trimmed === "" || /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) continue;
    // Bare list markers ("- ", "1.") carry no content.
    if (/^(?:[-*+]|\d{1,3}[.)])$/.test(trimmed)) continue;

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading && heading[1].length <= 2) {
      if (slides.length >= PPTX_MAX_SLIDES) {
        truncated = true;
        break;
      }
      current = {
        title: plainText(heading[2]).slice(0, PPTX_MAX_TITLE_CHARS) || "Untitled",
        bullets: []
      };
      slides.push(current);
      continue;
    }
    if (heading) {
      // ###+ subheadings become emphasized top-level bullets.
      pushBullet(plainText(heading[2]), 0);
      continue;
    }

    const bullet = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const text = plainText(bullet[2]).replace(/^\[[ xX]\]\s*/, "");
      if (text) pushBullet(text, bullet[1].length >= 2 ? 1 : 0);
      continue;
    }

    // Table rows / blockquotes degrade to their text; plain paragraphs
    // become top-level lines.
    const unquoted = trimmed.replace(/^>\s?/, "");
    const paragraph = unquoted.includes("|")
      ? unquoted
          .split("|")
          .map((cell) => plainText(cell))
          .filter((cell) => cell.length > 0)
          .join(" · ")
      : plainText(unquoted);
    if (paragraph && !/^[·\s-]+$/.test(paragraph)) pushBullet(paragraph, 0);
  }

  return { title, slides, truncated };
}

/** Render the deck to .pptx bytes (16:9, simple readable theme). */
export async function renderPptxBuffer(deck: SlideDeck): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";
  pptx.author = "New Coworker";
  pptx.title = deck.title;

  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: "1F2430" };
  titleSlide.addText(deck.title, {
    x: 0.8,
    y: 2.7,
    w: 11.7,
    h: 1.6,
    fontSize: 40,
    bold: true,
    color: "F5EFE0"
  });

  for (const slide of deck.slides) {
    const s = pptx.addSlide();
    s.background = { color: "FFFFFF" };
    s.addText(slide.title, {
      x: 0.6,
      y: 0.4,
      w: 12.1,
      h: 0.9,
      fontSize: 28,
      bold: true,
      color: "1F2430"
    });
    if (slide.bullets.length > 0) {
      s.addText(
        slide.bullets.map((b) => ({
          text: b.text,
          options: {
            bullet: true,
            indentLevel: b.indent,
            fontSize: b.indent === 0 ? 16 : 14,
            color: "333333",
            breakLine: true
          }
        })),
        { x: 0.8, y: 1.5, w: 11.7, h: 5.4, valign: "top" }
      );
    }
  }

  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}

/** Sanitized download filename for a deck. */
export function pptxFilename(title: string): string {
  const base = title
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `${base || "presentation"}.pptx`;
}
