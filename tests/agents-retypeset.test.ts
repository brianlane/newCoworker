import { describe, expect, it } from "vitest";
import {
  ensureHtmlDocument,
  htmlArtifactToText,
  isHtmlDocumentArtifact,
  sanitizeRetypesetHtml
} from "@/lib/agents/retypeset";

describe("isHtmlDocumentArtifact", () => {
  it("recognizes full HTML documents only", () => {
    expect(isHtmlDocumentArtifact("<!DOCTYPE html><html></html>")).toBe(true);
    expect(isHtmlDocumentArtifact("  \n<HTML lang='en'>x</HTML>")).toBe(true);
    expect(isHtmlDocumentArtifact("# Markdown heading")).toBe(false);
    expect(isHtmlDocumentArtifact("<div>fragment</div>")).toBe(false);
  });
});

describe("ensureHtmlDocument", () => {
  it("passes full documents through untouched", () => {
    const doc = "<!DOCTYPE html><html><body>x</body></html>";
    expect(ensureHtmlDocument(doc)).toBe(doc);
  });

  it("wraps fragments into a full document", () => {
    const wrapped = ensureHtmlDocument("<div>fragment</div>");
    expect(wrapped.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(wrapped).toContain("<div>fragment</div>");
    expect(isHtmlDocumentArtifact(wrapped)).toBe(true);
  });
});

describe("sanitizeRetypesetHtml", () => {
  it("strips scripts, embeds, and frame elements", () => {
    const out = sanitizeRetypesetHtml(
      '<html><body><script>alert(1)</script><script src="https://x.com/a.js">' +
        "</script><iframe src=\"https://x.com\">inner</iframe><object data='x'></object>" +
        "<embed src='y'><frame></frame>ok</body></html>"
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<iframe/i);
    expect(out).not.toMatch(/<object/i);
    expect(out).not.toMatch(/<embed/i);
    expect(out).not.toMatch(/<frame/i);
    expect(out).toContain("ok");
  });

  it("strips inline event handlers in every quoting form", () => {
    const out = sanitizeRetypesetHtml(
      `<div onclick="steal()" onmouseover='x()' onfocus=bad>text</div>`
    );
    expect(out).not.toMatch(/on\w+\s*=/i);
    expect(out).toContain("text");
  });

  it("keeps data: URIs and anchors but drops external src/href", () => {
    const out = sanitizeRetypesetHtml(
      '<img src="data:image/png;base64,AAAA"><a href="#section">jump</a>' +
        "<img src='https://evil.example/x.png'><a href=https://evil.example>out</a>" +
        '<a href="javascript:alert(1)">js</a>'
    );
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('href="#section"');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("javascript:");
  });

  it("neutralizes CSS network escapes (url() and @import) but keeps data: urls", () => {
    const out = sanitizeRetypesetHtml(
      "<style>body { background: url('https://x.com/bg.png'); } " +
        '.logo { background: url("data:image/png;base64,BBBB"); } ' +
        "@import url(https://x.com/f.css);</style>"
    );
    expect(out).not.toContain("https://x.com/bg.png");
    expect(out).toContain("data:image/png;base64,BBBB");
    expect(out).not.toMatch(/@import/i);
  });

  it("removes <link> and <base> tags", () => {
    const out = sanitizeRetypesetHtml(
      '<head><link rel="stylesheet" href="https://cdn.example/a.css"><base href="https://x.com/"></head>'
    );
    expect(out).not.toMatch(/<link/i);
    expect(out).not.toMatch(/<base/i);
  });
});

describe("htmlArtifactToText", () => {
  it("drops style/script bodies, breaks on block tags, and decodes entities", () => {
    const text = htmlArtifactToText(
      "<!DOCTYPE html><html><head><style>body{color:red}</style></head><body>" +
        "<h1>Quote &amp; Summary</h1><p>Premium: $1,200</p>" +
        "<table><tr><td>A &lt;cell&gt;</td></tr></table>" +
        "<div>It&#39;s &quot;fine&quot;&nbsp;here</div></body></html>"
    );
    expect(text).not.toContain("color:red");
    expect(text).toContain("Quote & Summary");
    expect(text).toContain("Premium: $1,200");
    expect(text).toContain("A <cell>");
    expect(text).toContain(`It's "fine" here`);
    // Block tags became line breaks, so headings sit on their own line.
    expect(text.split("\n")[0]).toContain("Quote & Summary");
  });
});
