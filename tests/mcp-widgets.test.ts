/**
 * Guards for the inline widgets.
 *
 * These are HTML documents shipped to a third-party host and handed
 * customer-supplied text at runtime, which is a combination with exactly two
 * ways to go badly wrong: reaching out to the network, and turning a customer's
 * name into markup. Both are asserted here rather than left to review, because
 * both are invisible in a diff that otherwise looks like styling.
 */

import { describe, expect, it } from "vitest";
import {
  MCP_TOOL_WIDGET,
  MCP_WIDGET_CSP,
  MCP_WIDGET_MIME,
  MCP_WIDGET_URI,
  MCP_WIDGETS,
  widgetMetaForTool
} from "@/lib/mcp/widgets";
import { allMcpTools } from "@/lib/mcp/registry";

describe("widget documents", () => {
  it("ships the three widgets, each a complete document", () => {
    expect(MCP_WIDGETS).toHaveLength(3);
    for (const w of MCP_WIDGETS) {
      expect(w.html.startsWith("<!doctype html>"), w.name).toBe(true);
      expect(w.html).toContain("</html>");
      expect(w.uri.startsWith("ui://"), w.name).toBe(true);
    }
  });

  /**
   * The one that matters most. Widgets render contact names, message bodies
   * and call transcripts, all of which a customer controls. Building DOM with
   * textContent is what keeps a contact named `<img onerror=...>` from being
   * markup rather than a name.
   */
  it("never assigns innerHTML, outerHTML, or writes to the document", () => {
    for (const w of MCP_WIDGETS) {
      expect(w.html, `${w.name} uses innerHTML`).not.toMatch(/\.innerHTML\s*=/);
      expect(w.html, `${w.name} uses outerHTML`).not.toMatch(/\.outerHTML\s*=/);
      expect(w.html, `${w.name} uses insertAdjacentHTML`).not.toContain("insertAdjacentHTML");
      expect(w.html, `${w.name} uses document.write`).not.toContain("document.write");
      expect(w.html, `${w.name} uses eval`).not.toMatch(/\beval\(/);
    }
  });

  /**
   * A Content Security Policy is declared at submission and a reviewer checks
   * it. Ours allows nothing, which is only true while the documents fetch
   * nothing, so the claim and the documents are asserted together.
   */
  it("loads nothing from anywhere, matching the empty CSP we declare", () => {
    for (const w of MCP_WIDGETS) {
      expect(w.html, `${w.name} has an absolute URL`).not.toMatch(/https?:\/\//);
      expect(w.html, `${w.name} fetches`).not.toMatch(/\bfetch\(/);
      expect(w.html, `${w.name} opens a socket`).not.toContain("WebSocket");
      expect(w.html, `${w.name} has an external script`).not.toMatch(/<script[^>]+src=/);
      expect(w.html, `${w.name} imports a stylesheet`).not.toContain("@import");
    }
    expect(MCP_WIDGET_CSP.connectDomains).toEqual([]);
    expect(MCP_WIDGET_CSP.resourceDomains).toEqual([]);
  });

  it("styles both themes, because ChatGPT renders light and dark", () => {
    for (const w of MCP_WIDGETS) {
      expect(w.html, `${w.name} has no dark styling`).toContain("prefers-color-scheme:dark");
      expect(w.html).toContain("color-scheme:light dark");
    }
  });

  it("survives a payload that is missing, empty, or the wrong shape", () => {
    // The host decides what it hands over and when. A widget that threw on a
    // null payload would render a blank card in the transcript.
    for (const w of MCP_WIDGETS) {
      expect(w.html, `${w.name} does not guard the payload`).toMatch(/Array\.isArray|\?\./);
      expect(w.html, `${w.name} does not catch a render failure`).toContain("catch");
    }
  });
});

describe("attaching a widget to a tool", () => {
  it("points only at widgets that exist", () => {
    // Widened: MCP_WIDGET_URI is const-asserted to its three literals, while
    // MCP_TOOL_WIDGET values are plain strings, and the point of the check is
    // exactly that an arbitrary string might not be one of them.
    const known = new Set<string>(Object.values(MCP_WIDGET_URI));
    for (const [tool, uri] of Object.entries(MCP_TOOL_WIDGET)) {
      expect(known.has(uri), `${tool} points at an unknown widget`).toBe(true);
    }
  });

  it("only names tools that are actually registered", () => {
    // A typo here is silent: the tool renders as text and nobody notices.
    const names = new Set(allMcpTools.map((t) => t.name));
    for (const tool of Object.keys(MCP_TOOL_WIDGET)) {
      expect(names.has(tool), `${tool} is not a registered tool`).toBe(true);
    }
  });

  /**
   * Two keys for one thing, on purpose. `ui/resourceUri` is the standard and
   * `openai/outputTemplate` is the alias ChatGPT still reads: shipping only
   * the standard renders nothing there today, and shipping only the alias bets
   * on it never being retired.
   */
  it("carries both the standard key and the ChatGPT alias", () => {
    const meta = widgetMetaForTool("get_contact");
    expect(meta).toBeDefined();
    const ui = meta?.ui as Record<string, unknown>;
    expect(ui.resourceUri).toBe(MCP_WIDGET_URI.contact);
    expect(meta?.["openai/outputTemplate"]).toBe(MCP_WIDGET_URI.contact);
  });

  it("gives no meta to a tool that renders as text", () => {
    // Absent, not an empty object: an explicit empty _meta is a different
    // thing on the wire from having none.
    expect(widgetMetaForTool("send_sms")).toBeUndefined();
    expect(widgetMetaForTool("list_flows")).toBeUndefined();
  });

  it("uses the Apps SDK resource profile, not plain text/html", () => {
    expect(MCP_WIDGET_MIME).toBe("text/html;profile=mcp-app");
  });
});

/**
 * Three fixes from review, each pinned because each is invisible in a diff
 * that looks like styling or wording.
 */
describe("the slot picker's correctness details", () => {
  const slots = MCP_WIDGETS.find((w) => w.name === "calendar-slots")!.html;

  /**
   * The one with real-world teeth. Labelling a slot in the READER's timezone
   * while the badge names the BUSINESS's is how a 2pm slot gets read as a
   * different hour than it is, which is the same mixup that made
   * MCP_TIMEZONE_RULE necessary on the send tools.
   */
  it("formats slot times in the business timezone, not the reader's", () => {
    expect(slots).toContain("opts.timeZone = data.timezone");
    // And an unusable IANA zone must not blank the list.
    expect(slots).toContain("delete opts.timeZone");
  });

  /**
   * calendar_book_appointment takes startIso/endIso. Handing the model only a
   * formatted label makes it reverse a display string back into an instant,
   * which is how the wrong hour gets booked.
   */
  it("passes the ISO instants back, not just the printed label", () => {
    expect(slots).toContain("startIso");
    expect(slots).toContain("endIso");
    expect(slots).toMatch(/sendFollowUpMessage/);
  });

  it("does not book directly, so the model still confirms who it is for", () => {
    expect(slots).not.toContain("callTool");
  });
});

describe("dark theme contrast", () => {
  it("darkens the text on the accent, since the dark accent is a light mint", () => {
    // white on #4fd1bd fails contrast and made outbound messages unreadable.
    for (const w of MCP_WIDGETS) {
      expect(w.html, `${w.name} still hardcodes white on the accent`).not.toContain(
        "background:var(--accent);color:#fff"
      );
    }
    const any = MCP_WIDGETS[0].html;
    expect(any).toContain("--on-accent");
    expect(any).toMatch(/prefers-color-scheme:dark\)\{:root\{[^}]*--on-accent/);
  });
});
