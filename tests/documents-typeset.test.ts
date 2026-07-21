import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  PDF_MIME_TYPE,
  parseMarkdownBlocks,
  renderMarkdownToDocx,
  renderMarkdownToPdf,
  toWinAnsi,
  typesetArtifact,
  typesetTargetKind
} from "@/lib/documents/typeset";
import { DOCX_MIME_TYPE, decodeDocxToText } from "@/lib/documents/docx";

const RICH_MARKDOWN = [
  "# Quote comparison",
  "",
  "## Carriers",
  "",
  "### Detail",
  "",
  "#### Level four",
  "",
  "##### Level five",
  "",
  "###### Level six",
  "",
  "A paragraph with **bold**, *italic*, ***both***, `code`, ~~gone~~, and a",
  "[link](https://example.com) plus an image ![alt text](https://example.com/i.png).",
  "",
  "Line one  ",
  "line two after a hard break.",
  "",
  "- First bullet",
  "- Second bullet with **emphasis**",
  "  - Nested bullet",
  "",
  "1. Step one",
  "2. Step two",
  "",
  "> A quoted paragraph.",
  "",
  "| Carrier | Premium |",
  "|---------|---------|",
  "| Acme    | $1,200  |",
  "| Zenith  | $990    |",
  "",
  "```",
  "SELECT 1;",
  "```",
  "",
  "---",
  "",
  "Closing paragraph with café, año, and — dashes “quoted”."
].join("\n");

describe("parseMarkdownBlocks", () => {
  it("maps the full markdown vocabulary onto the block model", () => {
    const blocks = parseMarkdownBlocks(RICH_MARKDOWN);
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toContain("heading");
    expect(kinds).toContain("paragraph");
    expect(kinds).toContain("list");
    expect(kinds).toContain("table");
    expect(kinds).toContain("code");
    expect(kinds).toContain("hr");

    const headings = blocks.filter((b) => b.kind === "heading");
    expect(headings.map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);

    const styled = blocks.find(
      (b) => b.kind === "paragraph" && b.runs.some((r) => r.bold && r.italic)
    );
    expect(styled).toBeDefined();
    const styledRuns = styled!.kind === "paragraph" ? styled!.runs : [];
    expect(styledRuns.some((r) => r.bold && !r.italic && r.text.includes("bold"))).toBe(true);
    expect(styledRuns.some((r) => !r.bold && r.italic && r.text.includes("italic"))).toBe(true);
    expect(styledRuns.some((r) => r.text.includes("link"))).toBe(true);
    expect(styledRuns.some((r) => r.text.includes("alt text"))).toBe(true);
    expect(styledRuns.some((r) => r.text.includes("gone"))).toBe(true);

    const lists = blocks.filter((b) => b.kind === "list");
    expect(lists).toHaveLength(2);
    const bullets = lists.find((l) => l.kind === "list" && !l.ordered)!;
    expect(bullets.kind === "list" && bullets.items).toHaveLength(3); // nested flattened
    const ordered = lists.find((l) => l.kind === "list" && l.ordered)!;
    expect(ordered.kind === "list" && ordered.items).toHaveLength(2);

    // Blockquote children flatten into plain paragraphs.
    expect(
      blocks.some(
        (b) => b.kind === "paragraph" && b.runs.some((r) => r.text.includes("quoted paragraph"))
      )
    ).toBe(true);

    const table = blocks.find((b) => b.kind === "table")!;
    expect(table.kind === "table" && table.rows).toHaveLength(3);
  });

  it("collapses soft line-wraps and hard breaks into spaces", () => {
    const blocks = parseMarkdownBlocks("Line one  \nline two\ncontinues");
    expect(blocks).toHaveLength(1);
    const text = blocks[0].kind === "paragraph" ? blocks[0].runs.map((r) => r.text).join("") : "";
    expect(text).toBe("Line one line two continues");
  });

  it("degrades raw HTML blocks and inline HTML to visible text", () => {
    const blocks = parseMarkdownBlocks("<div>block html</div>\n\nkeep <b>bold tag</b> text");
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      runs: [{ text: "block html", bold: false, italic: false }]
    });
    const inline = blocks[1].kind === "paragraph" ? blocks[1].runs.map((r) => r.text).join("") : "";
    expect(inline).toContain("bold tag");
  });

  it("handles escapes, code blocks inside list items, and empty inputs", () => {
    expect(parseMarkdownBlocks("")).toEqual([]);
    const escaped = parseMarkdownBlocks("\\*not bold\\*");
    const text = escaped[0].kind === "paragraph" ? escaped[0].runs.map((r) => r.text).join("") : "";
    expect(text).toBe("*not bold*");

    // A list item carrying a non-text child block keeps its visible text.
    const withCode = parseMarkdownBlocks("- item\n\n      indented code in item");
    expect(withCode.some((b) => b.kind === "list" || b.kind === "code")).toBe(true);

    const multiBlockItem = parseMarkdownBlocks("1. first line\n\n   second paragraph of item");
    const item = multiBlockItem.find((b) => b.kind === "list")!;
    const itemText =
      item.kind === "list" ? item.items[0].map((r) => r.text).join("") : "";
    expect(itemText).toContain("first line");
    expect(itemText).toContain("second paragraph");
  });

  it("drops empty images and empty list items", () => {
    const blocks = parseMarkdownBlocks("![](https://example.com/i.png)\n\n- real item\n- ");
    const list = blocks.find((b) => b.kind === "list");
    expect(list && list.kind === "list" ? list.items : []).toHaveLength(1);
  });

  it("drops a list whose items are all empty", () => {
    expect(parseMarkdownBlocks("-\n-").some((b) => b.kind === "list")).toBe(false);
  });

  it("keeps a list item whose first child is not inline text", () => {
    const blocks = parseMarkdownBlocks("- > quoted first child");
    const list = blocks.find((b) => b.kind === "list")!;
    const itemText = list.kind === "list" ? list.items[0].map((r) => r.text).join("") : "";
    expect(itemText).toContain("quoted first child");
  });

  it("skips block constructs that strip to no visible text", () => {
    expect(parseMarkdownBlocks("<!-- an html comment -->")).toEqual([]);
  });
});

describe("toWinAnsi", () => {
  it("keeps ASCII, Latin-1, and WinAnsi typographic extras", () => {
    expect(toWinAnsi("plain café año €99 — “x” • …")).toBe("plain café año €99 — “x” • …");
  });

  it("replaces unencodable characters and flattens control whitespace", () => {
    expect(toWinAnsi("emoji 😀 tab\tnewline\ncr\r日本")).toBe("emoji ? tab newline cr ??");
  });
});

describe("renderMarkdownToPdf", () => {
  it("produces a loadable PDF from rich markdown", async () => {
    const bytes = await renderMarkdownToPdf(RICH_MARKDOWN);
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("breaks onto additional pages for long content", async () => {
    const long = Array.from({ length: 80 }, (_, i) => `Paragraph ${i} with several words.`).join(
      "\n\n"
    );
    const doc = await PDFDocument.load(await renderMarkdownToPdf(long));
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("survives over-wide words, long code lines, and multi-page tables", async () => {
    const wideWord = "x".repeat(400);
    const codeLine = "y".repeat(400);
    const tableRows = Array.from({ length: 70 }, (_, i) => `| row ${i} | value ${i} |`).join("\n");
    const md = [
      wideWord,
      "",
      "```",
      codeLine,
      "short",
      "```",
      "",
      "| A | B |",
      "|---|---|",
      tableRows
    ].join("\n");
    const doc = await PDFDocument.load(await renderMarkdownToPdf(md));
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("renders an empty document without failing", async () => {
    const doc = await PDFDocument.load(await renderMarkdownToPdf(""));
    expect(doc.getPageCount()).toBe(1);
  });

  it("renders tables with empty and missing cells", async () => {
    const md = "| A | B |\n|---|---|\n| only |  |";
    const doc = await PDFDocument.load(await renderMarkdownToPdf(md));
    expect(doc.getPageCount()).toBe(1);
  });
});

describe("renderMarkdownToDocx", () => {
  it("produces a Word document whose text round-trips", async () => {
    const bytes = await renderMarkdownToDocx(RICH_MARKDOWN);
    // DOCX is a zip: PK magic.
    expect(bytes.subarray(0, 2).toString("ascii")).toBe("PK");
    const text = await decodeDocxToText(bytes);
    expect(text).toContain("Quote comparison");
    expect(text).toContain("First bullet");
    expect(text).toContain("Step one");
    expect(text).toContain("Acme");
    expect(text).toContain("SELECT 1;");
    expect(text).toContain("Closing paragraph with café");
  });

  it("renders an empty document without failing", async () => {
    const bytes = await renderMarkdownToDocx("");
    expect(bytes.subarray(0, 2).toString("ascii")).toBe("PK");
  });
});

describe("typesetArtifact", () => {
  it("maps mimes onto renderer kinds", () => {
    expect(typesetTargetKind(` ${PDF_MIME_TYPE.toUpperCase()} `)).toBe("pdf");
    expect(typesetTargetKind(DOCX_MIME_TYPE)).toBe("docx");
    expect(typesetTargetKind("text/markdown")).toBeNull();
  });

  it("typesets pdf and docx targets and passes text targets through", async () => {
    const pdf = await typesetArtifact("# Hi", PDF_MIME_TYPE);
    expect(pdf!.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const docx = await typesetArtifact("# Hi", DOCX_MIME_TYPE);
    expect(docx!.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(await typesetArtifact("# Hi", "text/csv")).toBeNull();
  });
});
