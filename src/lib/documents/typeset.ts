/**
 * Typeset agent artifacts — deterministic markdown → PDF / DOCX rendering.
 *
 * The model always produces markdown (the run's `output_md` source of
 * truth); when an agent's output format is `pdf` or `docx` the artifact is
 * typeset into real bytes at persistence/download time. Pure JS end to end
 * (marked lexer → block model → pdf-lib / docx renderers): serverless-safe,
 * no headless browser, works on every tier.
 *
 * The block model is intentionally small — headings, paragraphs, lists,
 * simple tables, code, rules — because the input is our own model's
 * markdown, not arbitrary documents. Unknown markdown constructs degrade to
 * plain paragraphs rather than failing the run.
 */

import { marked, type Token, type Tokens } from "marked";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from "docx";
import sanitizeHtmlLib from "sanitize-html";
import { DOCX_MIME_TYPE } from "./docx";

export const PDF_MIME_TYPE = "application/pdf";

/** One styled text span inside a block. */
export type InlineRun = { text: string; bold: boolean; italic: boolean };

export type TypesetBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; runs: InlineRun[] }
  | { kind: "paragraph"; runs: InlineRun[] }
  | { kind: "list"; ordered: boolean; items: InlineRun[][] }
  /** rows[0] is the header row; each cell is a run list. */
  | { kind: "table"; rows: InlineRun[][][] }
  | { kind: "code"; text: string }
  | { kind: "hr" };

/**
 * Strip tags from an inline/block HTML fragment — keep the visible text.
 * Parsed with sanitize-html (never regex) so malformed markup can't leak
 * tag fragments into the typeset text.
 */
function htmlToText(html: string): string {
  return sanitizeHtmlLib(html, { allowedTags: [], allowedAttributes: {} }).trim();
}

/** Flatten marked inline tokens into styled runs. */
function inlineRuns(tokens: Token[] | undefined, bold: boolean, italic: boolean): InlineRun[] {
  const runs: InlineRun[] = [];
  const push = (text: string, b: boolean, i: boolean): void => {
    if (text.length === 0) return;
    const prev = runs[runs.length - 1];
    if (prev && prev.bold === b && prev.italic === i) prev.text += text;
    else runs.push({ text, bold: b, italic: i });
  };
  /* c8 ignore next -- callers always pass a token array; `??` is a type guard */
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "strong":
        runs.push(...inlineRuns(token.tokens, true, italic));
        break;
      case "em":
        runs.push(...inlineRuns(token.tokens, bold, true));
        break;
      case "link":
      case "del":
        runs.push(...inlineRuns((token as Tokens.Link | Tokens.Del).tokens, bold, italic));
        break;
      case "codespan":
        push((token as Tokens.Codespan).text, bold, italic);
        break;
      case "image":
        push((token as Tokens.Image).text, bold, italic);
        break;
      case "br":
        push(" ", bold, italic);
        break;
      case "escape":
      case "text": {
        const t = token as Tokens.Text;
        // Nested-token text is unwrapped defensively (list items hand their
        // inner tokens straight to inlineRuns, so this guard is dormant).
        /* c8 ignore next 2 -- defensive: no current caller passes nested text tokens */
        if (t.tokens && t.tokens.length > 0) runs.push(...inlineRuns(t.tokens, bold, italic));
        else push(t.text.replace(/\s*\n\s*/g, " "), bold, italic);
        break;
      }
      case "html":
        push(htmlToText(token.raw), bold, italic);
        break;
      /* c8 ignore next 3 -- defensive: every documented inline type is handled above */
      default:
        push(token.raw.replace(/\s*\n\s*/g, " ").trim(), bold, italic);
        break;
    }
  }
  // Merge adjacent same-styled runs produced by nested recursion.
  const merged: InlineRun[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.bold === run.bold && prev.italic === run.italic) prev.text += run.text;
    else merged.push({ ...run });
  }
  return merged;
}

/** Inline runs of one list item (nested blocks flattened into the item). */
function listItemRuns(item: Tokens.ListItem): InlineRun[] {
  const runs: InlineRun[] = [];
  for (const token of item.tokens) {
    if (token.type === "list") continue; // nested lists become sibling items
    if (token.type === "text" || token.type === "paragraph") {
      const styled = inlineRuns((token as Tokens.Text | Tokens.Paragraph).tokens, false, false);
      if (runs.length > 0 && styled.length > 0) runs.push({ text: " ", bold: false, italic: false });
      runs.push(...styled);
    } else {
      const text = token.raw.replace(/\s*\n\s*/g, " ").trim();
      if (text) runs.push({ text: runs.length > 0 ? ` ${text}` : text, bold: false, italic: false });
    }
  }
  return runs;
}

/** Collect a list token's items, flattening nested lists into siblings. */
function listItems(token: Tokens.List): InlineRun[][] {
  const items: InlineRun[][] = [];
  for (const item of token.items) {
    const runs = listItemRuns(item);
    if (runs.length > 0) items.push(runs);
    for (const child of item.tokens) {
      if (child.type === "list") items.push(...listItems(child as Tokens.List));
    }
  }
  return items;
}

/** Parse markdown into the typeset block model (marked lexer, GFM). */
export function parseMarkdownBlocks(markdown: string): TypesetBlock[] {
  const blocks: TypesetBlock[] = [];
  for (const token of marked.lexer(markdown)) {
    switch (token.type) {
      case "heading": {
        const level = Math.min(Math.max(token.depth, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6;
        blocks.push({ kind: "heading", level, runs: inlineRuns(token.tokens, false, false) });
        break;
      }
      case "paragraph":
        blocks.push({ kind: "paragraph", runs: inlineRuns(token.tokens, false, false) });
        break;
      case "blockquote": {
        // Quotes flatten to plain paragraphs (their child blocks in order).
        for (const child of parseMarkdownBlocks((token as Tokens.Blockquote).text)) {
          blocks.push(child);
        }
        break;
      }
      case "list": {
        const items = listItems(token as Tokens.List);
        if (items.length > 0) {
          blocks.push({ kind: "list", ordered: (token as Tokens.List).ordered, items });
        }
        break;
      }
      case "table": {
        const t = token as Tokens.Table;
        const rows: InlineRun[][][] = [
          t.header.map((cell) => inlineRuns(cell.tokens, false, false)),
          ...t.rows.map((row) => row.map((cell) => inlineRuns(cell.tokens, false, false)))
        ];
        blocks.push({ kind: "table", rows });
        break;
      }
      case "code":
        blocks.push({ kind: "code", text: (token as Tokens.Code).text });
        break;
      case "hr":
        blocks.push({ kind: "hr" });
        break;
      case "space":
        break;
      default: {
        // Unknown/rare block constructs (raw HTML blocks etc.) degrade to a
        // plain paragraph of their visible text.
        const text = htmlToText(token.raw).replace(/\s*\n\s*/g, " ").trim();
        if (text) blocks.push({ kind: "paragraph", runs: [{ text, bold: false, italic: false }] });
        break;
      }
    }
  }
  return blocks;
}

// ── PDF rendering (pdf-lib, standard WinAnsi fonts) ─────────────────────────

/**
 * WinAnsi printable extras beyond Latin-1 (0x80–0x9F code points). The
 * standard PDF fonts can encode exactly WinAnsi — anything else is replaced
 * with "?" rather than throwing mid-render.
 */
const WINANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Coerce text to WinAnsi-encodable characters (Spanish/Latin-1 safe). */
export function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    // Iterating a string by code points always yields a code point.
    const code = ch.codePointAt(0) as number;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += " ";
    } else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += ch;
    } else if (WINANSI_EXTRA.has(ch)) {
      out += ch;
    } else {
      out += "?";
    }
  }
  return out;
}

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN = 56;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BODY_SIZE = 11;
const CODE_SIZE = 9.5;
const TABLE_SIZE = 9.5;
const HEADING_SIZES: Record<number, number> = { 1: 20, 2: 16, 3: 13.5, 4: 12, 5: 11.5, 6: 11 };
const TEXT_COLOR = rgb(0.1, 0.1, 0.12);
const RULE_COLOR = rgb(0.75, 0.75, 0.78);

type PdfFonts = {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
};

type PdfCursor = { doc: PDFDocument; page: PDFPage; y: number };

function fontFor(fonts: PdfFonts, run: InlineRun, forceBold: boolean): PDFFont {
  const bold = run.bold || forceBold;
  if (bold && run.italic) return fonts.boldItalic;
  if (bold) return fonts.bold;
  if (run.italic) return fonts.italic;
  return fonts.regular;
}

/** Start a new page when fewer than `needed` points remain above the margin. */
function ensureRoom(cursor: PdfCursor, needed: number): void {
  if (cursor.y - needed >= MARGIN) return;
  cursor.page = cursor.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  cursor.y = PAGE_HEIGHT - MARGIN;
}

type PdfWord = { text: string; font: PDFFont; width: number };

/** Hard-break a single over-wide word into width-fitting chunks. */
function breakWord(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const ch of word) {
    const next = current + ch;
    if (current.length > 0 && font.widthOfTextAtSize(next, size) > maxWidth) {
      chunks.push(current);
      current = ch;
    } else {
      current = next;
    }
  }
  // Callers never pass an empty word, so the tail chunk is always non-empty.
  chunks.push(current);
  return chunks;
}

/** Split styled runs into measured words for line wrapping. */
function measureWords(
  runs: InlineRun[],
  fonts: PdfFonts,
  size: number,
  maxWidth: number,
  forceBold: boolean
): PdfWord[] {
  const words: PdfWord[] = [];
  for (const run of runs) {
    const font = fontFor(fonts, run, forceBold);
    for (const raw of toWinAnsi(run.text).split(" ")) {
      if (raw.length === 0) continue;
      const width = font.widthOfTextAtSize(raw, size);
      if (width > maxWidth) {
        for (const chunk of breakWord(raw, font, size, maxWidth)) {
          words.push({ text: chunk, font, width: font.widthOfTextAtSize(chunk, size) });
        }
      } else {
        words.push({ text: raw, font, width });
      }
    }
  }
  return words;
}

/** Greedy-wrap measured words into lines that fit `maxWidth`. */
function wrapWords(words: PdfWord[], size: number, maxWidth: number): PdfWord[][] {
  const spaceWidth = size * 0.28;
  const lines: PdfWord[][] = [];
  let line: PdfWord[] = [];
  let lineWidth = 0;
  for (const word of words) {
    const added = line.length === 0 ? word.width : spaceWidth + word.width;
    if (line.length > 0 && lineWidth + added > maxWidth) {
      lines.push(line);
      line = [word];
      lineWidth = word.width;
    } else {
      line.push(word);
      lineWidth += added;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function drawLines(
  cursor: PdfCursor,
  lines: PdfWord[][],
  args: { x: number; size: number; lineHeight: number }
): void {
  const spaceWidth = args.size * 0.28;
  for (const line of lines) {
    ensureRoom(cursor, args.lineHeight);
    cursor.y -= args.lineHeight;
    let x = args.x;
    for (const word of line) {
      cursor.page.drawText(word.text, {
        x,
        y: cursor.y,
        size: args.size,
        font: word.font,
        color: TEXT_COLOR
      });
      x += word.width + spaceWidth;
    }
  }
}

function drawRunsBlock(
  cursor: PdfCursor,
  fonts: PdfFonts,
  runs: InlineRun[],
  args: { x: number; width: number; size: number; forceBold?: boolean }
): void {
  const words = measureWords(runs, fonts, args.size, args.width, args.forceBold === true);
  const lines = wrapWords(words, args.size, args.width);
  drawLines(cursor, lines, { x: args.x, size: args.size, lineHeight: args.size * 1.4 });
}

function drawTable(cursor: PdfCursor, fonts: PdfFonts, rows: InlineRun[][][]): void {
  const columns = Math.max(...rows.map((row) => row.length));
  const colWidth = USABLE_WIDTH / columns;
  const cellPad = 4;
  const cellTextWidth = colWidth - cellPad * 2;
  const lineHeight = TABLE_SIZE * 1.35;
  rows.forEach((row, rowIndex) => {
    const headerRow = rowIndex === 0;
    const cellLines = row.map((cell) =>
      wrapWords(measureWords(cell, fonts, TABLE_SIZE, cellTextWidth, headerRow), TABLE_SIZE, cellTextWidth)
    );
    const rowLines = Math.max(1, ...cellLines.map((lines) => lines.length));
    const rowHeight = rowLines * lineHeight + cellPad * 2;
    ensureRoom(cursor, rowHeight + 2);
    const rowTop = cursor.y;
    cellLines.forEach((lines, col) => {
      const cellCursor: PdfCursor = { doc: cursor.doc, page: cursor.page, y: rowTop - cellPad };
      drawLines(cellCursor, lines, {
        x: MARGIN + col * colWidth + cellPad,
        size: TABLE_SIZE,
        lineHeight
      });
    });
    cursor.y = rowTop - rowHeight;
    cursor.page.drawLine({
      start: { x: MARGIN, y: cursor.y },
      end: { x: MARGIN + USABLE_WIDTH, y: cursor.y },
      thickness: headerRow ? 1 : 0.5,
      color: RULE_COLOR
    });
  });
  cursor.y -= 8;
}

function drawCode(cursor: PdfCursor, fonts: PdfFonts, text: string): void {
  const lineHeight = CODE_SIZE * 1.4;
  for (const rawLine of text.split("\n")) {
    const safe = toWinAnsi(rawLine);
    const chunks =
      fonts.mono.widthOfTextAtSize(safe, CODE_SIZE) > USABLE_WIDTH
        ? breakWord(safe, fonts.mono, CODE_SIZE, USABLE_WIDTH)
        : [safe];
    for (const chunk of chunks) {
      ensureRoom(cursor, lineHeight);
      cursor.y -= lineHeight;
      cursor.page.drawText(chunk, {
        x: MARGIN,
        y: cursor.y,
        size: CODE_SIZE,
        font: fonts.mono,
        color: TEXT_COLOR
      });
    }
  }
  cursor.y -= 8;
}

/** Render markdown into PDF bytes (US Letter, standard fonts). */
export async function renderMarkdownToPdf(markdown: string): Promise<Buffer> {
  const blocks = parseMarkdownBlocks(markdown);
  const doc = await PDFDocument.create();
  const fonts: PdfFonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier)
  };
  const cursor: PdfCursor = {
    doc,
    page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: PAGE_HEIGHT - MARGIN
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        const size = HEADING_SIZES[block.level];
        cursor.y -= 6;
        drawRunsBlock(cursor, fonts, block.runs, {
          x: MARGIN,
          width: USABLE_WIDTH,
          size,
          forceBold: true
        });
        cursor.y -= 4;
        break;
      }
      case "paragraph":
        drawRunsBlock(cursor, fonts, block.runs, {
          x: MARGIN,
          width: USABLE_WIDTH,
          size: BODY_SIZE
        });
        cursor.y -= 6;
        break;
      case "list": {
        block.items.forEach((item, index) => {
          const prefix = block.ordered ? `${index + 1}.` : "•";
          ensureRoom(cursor, BODY_SIZE * 1.4);
          const itemTop = cursor.y;
          drawRunsBlock(cursor, fonts, item, {
            x: MARGIN + 18,
            width: USABLE_WIDTH - 18,
            size: BODY_SIZE
          });
          // The prefix sits on the item's first line (drawn after so the
          // wrap can't push it).
          cursor.page.drawText(prefix, {
            x: MARGIN + 2,
            y: itemTop - BODY_SIZE * 1.4,
            size: BODY_SIZE,
            font: fonts.regular,
            color: TEXT_COLOR
          });
          cursor.y -= 3;
        });
        cursor.y -= 5;
        break;
      }
      case "table":
        drawTable(cursor, fonts, block.rows);
        break;
      case "code":
        drawCode(cursor, fonts, block.text);
        break;
      case "hr":
        ensureRoom(cursor, 14);
        cursor.y -= 10;
        cursor.page.drawLine({
          start: { x: MARGIN, y: cursor.y },
          end: { x: MARGIN + USABLE_WIDTH, y: cursor.y },
          thickness: 0.75,
          color: RULE_COLOR
        });
        cursor.y -= 4;
        break;
    }
  }

  return Buffer.from(await doc.save());
}

// ── DOCX rendering (docx package) ───────────────────────────────────────────

const DOCX_HEADINGS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6
};

function docxRuns(runs: InlineRun[], forceBold = false): TextRun[] {
  return runs.map(
    (run) => new TextRun({ text: run.text, bold: run.bold || forceBold, italics: run.italic })
  );
}

/** Render markdown into DOCX bytes. */
export async function renderMarkdownToDocx(markdown: string): Promise<Buffer> {
  const blocks = parseMarkdownBlocks(markdown);
  const children: (Paragraph | Table)[] = [];
  // One numbering config per ordered list so each restarts at 1.
  const numberingConfigs: {
    reference: string;
    levels: {
      level: number;
      format: (typeof LevelFormat)[keyof typeof LevelFormat];
      text: string;
      alignment: (typeof AlignmentType)[keyof typeof AlignmentType];
    }[];
  }[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        children.push(
          new Paragraph({ heading: DOCX_HEADINGS[block.level], children: docxRuns(block.runs) })
        );
        break;
      case "paragraph":
        children.push(new Paragraph({ children: docxRuns(block.runs) }));
        break;
      case "list": {
        let numbering: { reference: string; level: number } | null = null;
        if (block.ordered) {
          const reference = `typeset-ordered-${numberingConfigs.length}`;
          numberingConfigs.push({
            reference,
            levels: [
              {
                level: 0,
                format: LevelFormat.DECIMAL,
                text: "%1.",
                alignment: AlignmentType.START
              }
            ]
          });
          numbering = { reference, level: 0 };
        }
        for (const item of block.items) {
          children.push(
            new Paragraph({
              children: docxRuns(item),
              ...(numbering ? { numbering } : { bullet: { level: 0 } })
            })
          );
        }
        break;
      }
      case "table":
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: block.rows.map(
              (row, rowIndex) =>
                new TableRow({
                  children: row.map(
                    (cell) =>
                      new TableCell({
                        children: [new Paragraph({ children: docxRuns(cell, rowIndex === 0) })]
                      })
                  )
                })
            )
          })
        );
        break;
      case "code":
        for (const line of block.text.split("\n")) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: line, font: "Courier New", size: 19 })]
            })
          );
        }
        break;
      case "hr":
        children.push(new Paragraph({ thematicBreak: true }));
        break;
    }
  }

  const doc = new Document({
    ...(numberingConfigs.length > 0 ? { numbering: { config: numberingConfigs } } : {}),
    sections: [{ children }]
  });
  return Packer.toBuffer(doc);
}

// ── Artifact entry point ────────────────────────────────────────────────────

/** Which typeset renderer a target mime needs (null = plain text artifact). */
export function typesetTargetKind(mime: string): "pdf" | "docx" | null {
  const trimmed = mime.trim().toLowerCase();
  if (trimmed === PDF_MIME_TYPE) return "pdf";
  if (trimmed === DOCX_MIME_TYPE) return "docx";
  return null;
}

/**
 * Typeset a markdown artifact for a binary target mime; null when the mime
 * is a plain-text representation (caller stores the markdown bytes as-is).
 */
export async function typesetArtifact(markdown: string, mime: string): Promise<Buffer | null> {
  const kind = typesetTargetKind(mime);
  if (kind === "pdf") return renderMarkdownToPdf(markdown);
  if (kind === "docx") return renderMarkdownToDocx(markdown);
  return null;
}
