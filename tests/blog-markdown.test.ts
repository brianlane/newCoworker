/**
 * Blog markdown renderer (src/lib/blog/markdown.ts): every supported
 * syntax branch, the HTML-escape-first security posture, and the
 * plain-text stripper.
 */
import { describe, expect, it } from "vitest";
import { markdownToPlainText, renderMarkdown } from "@/lib/blog/markdown";

describe("renderMarkdown", () => {
  it("renders headings h1-h6", () => {
    const html = renderMarkdown("# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six");
    expect(html).toContain("<h1>One</h1>");
    expect(html).toContain("<h2>Two</h2>");
    expect(html).toContain("<h3>Three</h3>");
    expect(html).toContain("<h4>Four</h4>");
    expect(html).toContain("<h5>Five</h5>");
    expect(html).toContain("<h6>Six</h6>");
  });

  it("renders paragraphs, joining consecutive lines", () => {
    expect(renderMarkdown("line one\nline two\n\nnext para")).toBe(
      "<p>line one line two</p>\n<p>next para</p>"
    );
  });

  it("renders bold, italic, and inline code", () => {
    const html = renderMarkdown("**bold** and *italic* and `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders https links and images; refuses javascript: URLs", () => {
    const html = renderMarkdown(
      "[ok](https://example.com) ![alt text](https://example.com/i.png) [bad](javascript:alert(1))"
    );
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>'
    );
    expect(html).toContain('<img src="https://example.com/i.png" alt="alt text"');
    // The unsafe URL renders as literal text, never as a clickable href.
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("[bad](javascript:alert(1))");
  });

  it("refuses javascript: image URLs too", () => {
    const html = renderMarkdown("![x](javascript:alert(1))");
    expect(html).not.toContain("<img");
  });

  it("escapes raw HTML instead of executing it", () => {
    const html = renderMarkdown('<script>alert("xss")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders unordered and ordered lists, switching kinds mid-stream", () => {
    const html = renderMarkdown("- a\n- b\n1. one\n2. two");
    expect(html).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
  });

  it("starts an ordered list directly (no preceding ul)", () => {
    expect(renderMarkdown("1. only")).toBe("<ol><li>only</li></ol>");
  });

  it("renders blockquotes (with and without a space after >)", () => {
    expect(renderMarkdown("> quoted\n>also quoted")).toBe(
      "<blockquote><p>quoted also quoted</p></blockquote>"
    );
  });

  it("renders horizontal rules from --- and ***", () => {
    const html = renderMarkdown("---\n***");
    expect(html).toBe("<hr />\n<hr />");
  });

  it("renders fenced code blocks with and without a language tag", () => {
    const withLang = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(withLang).toBe('<pre><code class="language-ts">const x = 1;</code></pre>');
    const noLang = renderMarkdown("```\nplain\n```");
    expect(noLang).toBe("<pre><code>plain</code></pre>");
  });

  it("escapes markup inside code blocks and keeps **x** literal in inline code", () => {
    const html = renderMarkdown("```\n<b>**not bold**</b>\n```");
    expect(html).toContain("&lt;b&gt;**not bold**&lt;/b&gt;");
    expect(renderMarkdown("`**literal**`")).toBe("<p><code>**literal**</code></p>");
  });

  it("closes an unterminated code fence at end of input (with and without a language)", () => {
    expect(renderMarkdown("```js\nconsole.log(1);")).toBe(
      '<pre><code class="language-js">console.log(1);</code></pre>'
    );
    expect(renderMarkdown("```\nplain tail")).toBe("<pre><code>plain tail</code></pre>");
  });

  it("a fence mid-document flushes the open paragraph first", () => {
    const html = renderMarkdown("para\n```\ncode\n```");
    expect(html).toBe("<p>para</p>\n<pre><code>code</code></pre>");
  });

  it("normalizes CRLF and flushes lists/quotes at paragraph boundaries", () => {
    const html = renderMarkdown("- item\r\ntext after\n> quote\ntext again");
    expect(html).toContain("<ul><li>item</li></ul>");
    expect(html).toContain("<blockquote><p>quote</p></blockquote>");
    expect(html).toContain("<p>text after</p>");
    expect(html).toContain("<p>text again</p>");
  });

  it("renders inline markup inside headings and list items", () => {
    expect(renderMarkdown("## A **bold** move")).toBe("<h2>A <strong>bold</strong> move</h2>");
    expect(renderMarkdown("- has [link](https://x.dev)")).toContain(
      '<li>has <a href="https://x.dev"'
    );
  });

  it("escapes quotes and apostrophes", () => {
    expect(renderMarkdown(`"quoted" and 'single'`)).toBe(
      "<p>&quot;quoted&quot; and &#39;single&#39;</p>"
    );
  });
});

describe("renderMarkdown — strikethrough, autolink, tables", () => {
  it("renders strikethrough", () => {
    expect(renderMarkdown("~~gone~~ still here")).toBe("<p><del>gone</del> still here</p>");
  });

  it("autolinks bare URLs at line start and mid-sentence, keeping trailing punctuation outside", () => {
    expect(renderMarkdown("https://a.dev")).toBe(
      '<p><a href="https://a.dev" target="_blank" rel="noopener noreferrer">https://a.dev</a></p>'
    );
    expect(renderMarkdown("see https://a.dev/x, then move on")).toBe(
      '<p>see <a href="https://a.dev/x" target="_blank" rel="noopener noreferrer">https://a.dev/x</a>, then move on</p>'
    );
  });

  it("does not double-link URLs inside markdown links or code spans", () => {
    const linked = renderMarkdown("[docs](https://a.dev)");
    expect(linked).toBe(
      '<a href="https://a.dev" target="_blank" rel="noopener noreferrer">docs</a>'
        .replace(/^/, "<p>")
        .concat("</p>")
    );
    expect(renderMarkdown("`https://a.dev`")).toBe("<p><code>https://a.dev</code></p>");
  });

  it("renders a GFM table with header and body", () => {
    const html = renderMarkdown(
      "| Plan | Price |\n| --- | :---: |\n| Starter | $9.99 |\n| Standard | **$99** |"
    );
    expect(html).toBe(
      "<table><thead><tr><th>Plan</th><th>Price</th></tr></thead>" +
        "<tbody><tr><td>Starter</td><td>$9.99</td></tr>" +
        "<tr><td>Standard</td><td><strong>$99</strong></td></tr></tbody></table>"
    );
  });

  it("renders a header-only table without a tbody", () => {
    expect(renderMarkdown("| A | B |\n| --- | --- |")).toBe(
      "<table><thead><tr><th>A</th><th>B</th></tr></thead></table>"
    );
  });

  it("falls back to a paragraph when the separator row is missing or malformed", () => {
    expect(renderMarkdown("| just | one |")).toBe("<p>| just | one |</p>");
    expect(renderMarkdown("| a | b |\n| -- | nope |")).toBe("<p>| a | b | | -- | nope |</p>");
  });

  it("flushes an open paragraph before a table and closes the table at the next block", () => {
    const html = renderMarkdown("intro text\n| A |\n| --- |\n| 1 |\nafter text");
    expect(html).toBe(
      "<p>intro text</p>\n" +
        "<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>\n" +
        "<p>after text</p>"
    );
  });

  it("flushes a table at end of input", () => {
    expect(renderMarkdown("| A |\n| --- |")).toContain("<table>");
  });
});

describe("markdownToPlainText", () => {
  it("strips code blocks, links, images, and markup", () => {
    const text = markdownToPlainText(
      "# Title\n\nSome **bold** `code` and [a link](https://x.dev) plus ![alt](https://x.dev/i.png)\n\n```\nignored\n```\n> quote"
    );
    expect(text).toBe("Title Some bold code and a link plus alt quote");
  });

  it("collapses whitespace", () => {
    expect(markdownToPlainText("a\n\n\nb   c")).toBe("a b c");
  });

  it("strips table pipes, separator rows, and strikethrough markers", () => {
    expect(markdownToPlainText("| Plan | Price |\n| --- | --- |\n| Starter | ~~$20~~ $9.99 |")).toBe(
      "Plan Price Starter $20 $9.99"
    );
  });
});
