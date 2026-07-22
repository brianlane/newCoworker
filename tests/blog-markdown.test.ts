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
});
