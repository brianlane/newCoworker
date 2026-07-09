import { describe, it, expect } from "vitest";
import {
  htmlToText,
  looksLikeStrippedTemplate
} from "../cloudflare/email-worker/src/html-text";

describe("email worker htmlToText", () => {
  it("drops <style> contents instead of leaking CSS as body text (the Mailchimp bug)", () => {
    const html = `<!doctype html>
<html>
  <head>
    <title>*|MC:SUBJECT|*</title>
    <style type="text/css">
      p{ margin:10px 0; padding:0; }
      #outlook a{ padding:0; }
      img{ -ms-interpolation-mode:bicubic; }
    </style>
  </head>
  <body>
    <p>Hello there,</p>
    <p>Your appointment is confirmed.</p>
  </body>
</html>`;
    expect(htmlToText(html)).toBe("Hello there, Your appointment is confirmed.");
  });

  it("drops <script> contents", () => {
    expect(htmlToText("<script>var x = 1;</script><p>Body</p>")).toBe("Body");
  });

  it("drops MSO conditional comments including their inner markup", () => {
    const html =
      "<!--[if mso]><style>.mso-only{color:red}</style><![endif]--><p>Visible</p><!-- plain comment -->";
    expect(htmlToText(html)).toBe("Visible");
  });

  it("drops a stray <title> outside <head>", () => {
    expect(htmlToText("<title>*|MC:SUBJECT|*</title><p>Real text</p>")).toBe("Real text");
  });

  it("decodes common entities and collapses whitespace", () => {
    expect(htmlToText("<p>Tom&nbsp;&amp;&nbsp;Jerry &lt;3   &quot;cheese&quot;</p>")).toBe(
      'Tom & Jerry <3 "cheese"'
    );
  });

  it("does not double-unescape &amp;lt;", () => {
    expect(htmlToText("a &amp;lt; b")).toBe("a &lt; b");
  });

  it("returns empty string for empty input", () => {
    expect(htmlToText("")).toBe("");
  });
});

describe("looksLikeStrippedTemplate", () => {
  it("flags an unrendered Mailchimp merge tag (the Privyr case)", () => {
    expect(looksLikeStrippedTemplate("*|MC:SUBJECT|*\n\np{\n margin:10px 0;\n}")).toBe(true);
  });

  it("flags text containing several CSS rule blocks even without merge tags", () => {
    const junk = [
      "p{ margin:10px 0; padding:0; }",
      "table{ border-collapse:collapse; mso-table-lspace:0pt; }",
      "img{ -ms-interpolation-mode:bicubic; border:0; }",
      "Use the code 549829 to verify."
    ].join("\n");
    expect(looksLikeStrippedTemplate(junk)).toBe(true);
  });

  it("does not flag normal prose", () => {
    expect(
      looksLikeStrippedTemplate(
        "Hi team,\n\nYour appointment is confirmed for Friday at 2pm.\n\nThanks!"
      )
    ).toBe(false);
  });

  it("does not flag prose with a couple of incidental braces", () => {
    expect(
      looksLikeStrippedTemplate("The config is { retries: 3; timeout:10; } and { a:1; b:2; }.")
    ).toBe(false);
  });

  it("does not flag markdown-style emphasis that resembles pipes/stars", () => {
    expect(looksLikeStrippedTemplate("Totals: *|* is not a merge tag, nor is * | *")).toBe(false);
  });
});
