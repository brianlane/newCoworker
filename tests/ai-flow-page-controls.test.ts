import { describe, expect, it } from "vitest";
import { digestPageControls, stripCode, textOf } from "@/lib/ai-flows/page-controls";

describe("stripCode", () => {
  it("removes script and style bodies", () => {
    const out = stripCode(
      `<button>Keep</button><script>const a = "<button>Ghost</button>";</script><style>.x{}</style>`
    );
    expect(out).toContain("Keep");
    expect(out).not.toContain("Ghost");
    expect(out).not.toContain(".x{}");
  });

  it("removes a closing tag carrying ignored junk", () => {
    // `</script foo>` is valid HTML; a tighter `</script>` pattern walks past
    // it and leaves the whole script body in the digest.
    expect(stripCode(`<script>var x = 1;</script foo><p>after</p>`)).not.toContain("var x");
  });

  it("removes the code from overlapping script markup", () => {
    // A nested opening tag makes the non-greedy match end early, leaving a
    // stray closing tag behind. That leftover is inert (no body, and nothing
    // downstream renders it); what matters is that no code survives.
    const out = stripCode(`<script>alpha<script>beta</script foo></script>ok`);
    expect(out).not.toContain("alpha");
    expect(out).not.toContain("beta");
    expect(out).toContain("ok");
  });
});

describe("textOf", () => {
  it("strips tags and collapses whitespace", () => {
    expect(textOf("<span>  Accept   <b>lead</b>\n</span>")).toBe("Accept lead");
  });

  it("decodes each entity exactly once", () => {
    // Sequential decoding would turn "&amp;lt;" into "<". It means "&lt;".
    expect(textOf("&amp;lt;")).toBe("&lt;");
    expect(textOf("A&nbsp;&amp;&nbsp;B")).toBe("A & B");
  });

  it("leaves an entity it does not know alone", () => {
    expect(textOf("&copy;")).toBe("&copy;");
  });
});

describe("digestPageControls", () => {
  it("offers a button by its visible text", () => {
    const { controls } = digestPageControls(`<button class="sc-1a2b">Claim this lead</button>`);
    expect(controls).toEqual([
      {
        group: "Buttons",
        kind: "click_text",
        target: "Claim this lead",
        label: "Claim this lead"
      }
    ]);
  });

  it("falls back to aria-label for an icon-only button", () => {
    const { controls } = digestPageControls(
      `<button aria-label="Close drawer"><svg></svg></button>`
    );
    expect(controls[0].target).toBe("Close drawer");
  });

  it("offers submit and button inputs by their value", () => {
    const { controls } = digestPageControls(`<input type="submit" value="Send update">`);
    expect(controls[0]).toMatchObject({ kind: "click_text", target: "Send update" });
  });

  it("drops a control with no usable label", () => {
    expect(digestPageControls(`<button></button><input type="button">`).controls).toEqual([]);
  });

  it("prefers a select's name over its (often hashed) id, and lists its options", () => {
    const { controls } = digestPageControls(
      `<select id="sc-9f3e" name="stage">
         <option value="new">New</option>
         <option value="spoke">Spoke with them</option>
       </select>`
    );
    expect(controls[0]).toMatchObject({
      group: "Dropdowns",
      kind: "select_option",
      target: 'select[name="stage"]',
      options: ["New", "Spoke with them"]
    });
  });

  it("falls back to a select's id when it has no name", () => {
    const { controls } = digestPageControls(`<select id="stage-picker"><option>A</option></select>`);
    expect(controls[0].target).toBe("#stage-picker");
  });

  it("uses an option's value when it renders no text", () => {
    const { controls } = digestPageControls(
      `<select name="s"><option value="fallback"></option></select>`
    );
    expect(controls[0].options).toEqual(["fallback"]);
  });

  it("skips a select it cannot aim at", () => {
    expect(digestPageControls(`<select><option>A</option></select>`).controls).toEqual([]);
  });

  it("offers a named textarea as a selector, the shape the RE note field needed", () => {
    // The concrete miss this whole module exists for: the ReferralExchange
    // note box is textarea[name="message"], not a placeholder.
    const { controls } = digestPageControls(`<textarea name="message" rows="4"></textarea>`);
    expect(controls[0]).toMatchObject({
      group: "Text fields",
      kind: "fill_selector",
      target: 'textarea[name="message"]'
    });
  });

  it("offers a nameless field by its placeholder instead", () => {
    const { controls } = digestPageControls(`<input placeholder="Search leads">`);
    expect(controls[0]).toMatchObject({
      kind: "fill_placeholder",
      target: "Search leads",
      label: 'input with placeholder "Search leads"'
    });
  });

  it("mentions the placeholder alongside a named field", () => {
    const { controls } = digestPageControls(`<input name="q" placeholder="Search">`);
    expect(controls[0].label).toBe('input[name="q"] (Search)');
  });

  it("never offers a password or hidden field", () => {
    const { controls } = digestPageControls(
      `<input type="password" name="password"><input type="hidden" name="csrf">`
    );
    expect(controls).toEqual([]);
  });

  it("offers data-test and data-testid handles as selectors", () => {
    const { controls } = digestPageControls(
      `<div data-test="claim-button"></div><div data-testid="row-3"></div>`
    );
    expect(controls.map((c) => c.target)).toEqual([
      '[data-test="claim-button"]',
      '[data-testid="row-3"]'
    ]);
    expect(controls[0].kind).toBe("click_selector");
  });

  it("dedupes repeated controls and keeps first-seen order", () => {
    const { controls } = digestPageControls(
      `<button>Accept</button><button>Accept</button><button>Decline</button>`
    );
    expect(controls.map((c) => c.target)).toEqual(["Accept", "Decline"]);
  });

  it("caps a group so a long list page cannot flood the picker", () => {
    const html = Array.from({ length: 80 }, (_, i) => `<button>Row ${i}</button>`).join("");
    expect(digestPageControls(html).controls).toHaveLength(60);
  });

  it("lists off-page links with their text, skipping assets and in-page anchors", () => {
    const { links } = digestPageControls(
      `<a href="/leads/7">Jane Smith</a>
       <a href="#top">Top</a>
       <a href="mailto:x@y.com">Mail</a>
       <a href="/app.css">styles</a>`
    );
    expect(links).toEqual([{ href: "/leads/7", label: "Jane Smith" }]);
  });

  it("dedupes links by href and caps them", () => {
    const html =
      `<a href="/a">One</a><a href="/a">One again</a>` +
      Array.from({ length: 70 }, (_, i) => `<a href="/l/${i}">L${i}</a>`).join("");
    const { links } = digestPageControls(html);
    expect(links.filter((l) => l.href === "/a")).toHaveLength(1);
    expect(links).toHaveLength(60);
  });

  it("lists headings so the owner can confirm the page, deduped and capped", () => {
    const html =
      `<h1>Referral detail</h1><h2>Referral detail</h2><h3></h3>` +
      Array.from({ length: 30 }, (_, i) => `<h2>H${i}</h2>`).join("");
    const { headings } = digestPageControls(html);
    expect(headings[0]).toBe("Referral detail");
    expect(headings.filter((h) => h === "Referral detail")).toHaveLength(1);
    expect(headings).toHaveLength(20);
  });

  it("never surfaces anything from inside a script tag", () => {
    const digest = digestPageControls(
      `<script>document.write('<button>Injected</button>');</script><h1>Real</h1>`
    );
    expect(digest.controls).toEqual([]);
    expect(digest.headings).toEqual(["Real"]);
  });
});
