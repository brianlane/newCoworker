/**
 * Chat markdown parsing + wrap contract: long Zoom/calendar URLs used to
 * clip off the edge of the Ask AI companion (flex min-width:auto, no
 * overflow-wrap). The parser also turns http(s) markdown links into
 * tokens so "[Google Calendar link](https://...)" is a short label, not
 * a raw URL that overflowed the 400px panel.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAT_TEXT_WRAP_CLASS,
  chatImageFromLine,
  splitChatBlocks,
  tokenizeInlineMarkdown
} from "@/lib/chat-markdown";

const ROOT = join(import.meta.dirname, "..");
const IMAGE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const IMAGE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("CHAT_TEXT_WRAP_CLASS", () => {
  it("shrinks a flex bubble and wraps an unbreakable URL", () => {
    expect(CHAT_TEXT_WRAP_CLASS).toBe("min-w-0 break-words");
  });
});

describe("chatImageFromLine", () => {
  it("rebuilds a same-origin proxy src from charset-limited groups", () => {
    const line = `![A photo](/api/dashboard/images/${IMAGE_A.toUpperCase()}/${IMAGE_B.toUpperCase()}.PNG)`;
    expect(chatImageFromLine(`  ${line}  `)).toEqual({
      alt: "A photo",
      src: `/api/dashboard/images/${IMAGE_A}/${IMAGE_B}.png`
    });
  });

  it("defaults an empty alt and rejects anything that is not the proxy shape", () => {
    expect(
      chatImageFromLine(`![](/api/dashboard/images/${IMAGE_A}/${IMAGE_B}.webp)`)
    ).toEqual({
      alt: "Generated image",
      src: `/api/dashboard/images/${IMAGE_A}/${IMAGE_B}.webp`
    });
    expect(chatImageFromLine(`![x](https://evil.example/i.png)`)).toBeNull();
    expect(
      chatImageFromLine(`![x](/api/dashboard/images/${IMAGE_A}/${IMAGE_B}.png) trailing`)
    ).toBeNull();
  });
});

describe("tokenizeInlineMarkdown", () => {
  it("returns no tokens for empty input and a lone strong token", () => {
    expect(tokenizeInlineMarkdown("")).toEqual([]);
    expect(tokenizeInlineMarkdown("**bold**")).toEqual([{ type: "strong", value: "bold" }]);
  });

  it("leaves plain text, including javascript: markdown, as text", () => {
    expect(tokenizeInlineMarkdown("Just a sentence")).toEqual([
      { type: "text", value: "Just a sentence" }
    ]);
    expect(tokenizeInlineMarkdown("[bad](javascript:alert(1))")).toEqual([
      { type: "text", value: "[bad](javascript:alert(1))" }
    ]);
    expect(tokenizeInlineMarkdown("[rel](/dashboard)")).toEqual([
      { type: "text", value: "[rel](/dashboard)" }
    ]);
  });

  it("tokenizes bold, italic, code, markdown links, and bare URLs", () => {
    const tokens = tokenizeInlineMarkdown(
      "See **bold** and *italic* and `code` then [Calendar](https://calendar.google.com/event?eid=abc) and http://example.com/docs."
    );
    expect(tokens).toEqual([
      { type: "text", value: "See " },
      { type: "strong", value: "bold" },
      { type: "text", value: " and " },
      { type: "em", value: "italic" },
      { type: "text", value: " and " },
      { type: "code", value: "code" },
      { type: "text", value: " then " },
      {
        type: "link",
        href: "https://calendar.google.com/event?eid=abc",
        label: "Calendar"
      },
      { type: "text", value: " and " },
      { type: "link", href: "http://example.com/docs", label: "http://example.com/docs" },
      { type: "text", value: "." }
    ]);
  });

  it("does not turn ![alt](https://...) into a clickable image", () => {
    expect(tokenizeInlineMarkdown("pic ![alt](https://evil.example/i.png) end")).toEqual([
      { type: "text", value: "pic " },
      { type: "text", value: "![alt](https://evil.example/i.png)" },
      { type: "text", value: " end" }
    ]);
    expect(tokenizeInlineMarkdown("![alt](https://evil.example/i.png)")).toEqual([
      { type: "text", value: "![alt](https://evil.example/i.png)" }
    ]);
  });

  it("keeps balanced path parens on a bare URL and peels an extra one", () => {
    expect(tokenizeInlineMarkdown("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([
      {
        type: "link",
        href: "https://en.wikipedia.org/wiki/Foo_(bar)",
        label: "https://en.wikipedia.org/wiki/Foo_(bar)"
      }
    ]);
    expect(tokenizeInlineMarkdown("(https://example.com/)")).toEqual([
      { type: "text", value: "(" },
      { type: "link", href: "https://example.com/", label: "https://example.com/" },
      { type: "text", value: ")" }
    ]);
  });
});

describe("splitChatBlocks", () => {
  it("keeps a heading line as a paragraph and the bullets as a list", () => {
    const blocks = splitChatBlocks(
      [
        "I booked the Zoom meeting.",
        "",
        "Meeting Details:",
        "- Attendee: Brett Douglas (brett.douglas.fitness@gmail.com)",
        "- Time: Friday, September 18, 2026 at 12:45 PM CDT",
        "- Zoom Link:",
        "https://us06web.zoom.us/j/89867584537?pwd=abc",
        "- Zoom Meeting ID: 898 6758 8453",
        "- Calendar Event: [Google Calendar link](https://www.google.com/calendar/event?eid=abc)"
      ].join("\n")
    );
    expect(blocks).toEqual([
      { type: "paragraph", lines: ["I booked the Zoom meeting."] },
      {
        type: "paragraph",
        lines: ["Meeting Details:"]
      },
      {
        type: "list",
        items: [
          "Attendee: Brett Douglas (brett.douglas.fitness@gmail.com)",
          "Time: Friday, September 18, 2026 at 12:45 PM CDT",
          "Zoom Link:\nhttps://us06web.zoom.us/j/89867584537?pwd=abc",
          "Zoom Meeting ID: 898 6758 8453",
          "Calendar Event: [Google Calendar link](https://www.google.com/calendar/event?eid=abc)"
        ]
      }
    ]);
  });

  it("renders a generated-image block, skips a lone empty bullet, and keeps •/* markers", () => {
    const image = `![shot](/api/dashboard/images/${IMAGE_A}/${IMAGE_B}.jpg)`;
    expect(splitChatBlocks(image)).toEqual([
      {
        type: "image",
        alt: "shot",
        src: `/api/dashboard/images/${IMAGE_A}/${IMAGE_B}.jpg`
      }
    ]);
    expect(splitChatBlocks("- ")).toEqual([{ type: "paragraph", lines: ["- "] }]);
    expect(splitChatBlocks("Intro\n\n  \n- ")).toEqual([
      { type: "paragraph", lines: ["Intro"] },
      { type: "paragraph", lines: ["  ", "- "] }
    ]);
    expect(splitChatBlocks("• one\n \n* two")).toEqual([
      { type: "list", items: ["one", "two"] }
    ]);
  });

  it("drops a blank leading line before a list and folds a URL continuation", () => {
    expect(splitChatBlocks("   \n- Zoom Link:\nhttps://example.com/a")).toEqual([
      { type: "list", items: ["Zoom Link:\nhttps://example.com/a"] }
    ]);
  });
});

const CHAT_BUBBLE_FILES = [
  "src/components/dashboard/companion/CompanionPanel.tsx",
  "src/components/dashboard/DashboardChat.tsx",
  "src/app/dashboard/messages/[customerE164]/page.tsx",
  "src/app/dashboard/calls/[callControlId]/page.tsx",
  "src/app/dashboard/webchat/[sessionId]/page.tsx",
  "src/app/admin/(protected)/[businessId]/webchat/[sessionId]/page.tsx",
  "src/app/dashboard/messenger/[conversationId]/page.tsx",
  "src/app/onboard/questionnaire/QuestionnaireClient.tsx",
  "src/components/ui/ChatMarkdown.tsx"
];

const WRAP_HINT =
  /break-words|break-all|CHAT_TEXT_WRAP_CLASS|overflow-wrap|word-break|word-wrap/;

function walkSource(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "coverage") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkSource(full, acc);
    else if (/\.(ts|tsx|js|css)$/.test(name)) acc.push(full);
  }
  return acc;
}

describe("chat wrap surfaces", () => {
  it("doubles the companion panel from 400px to 800px", () => {
    const src = readFileSync(
      join(ROOT, "src/components/dashboard/companion/CompanionPanel.tsx"),
      "utf8"
    );
    expect(src).toContain("sm:w-[800px]");
    expect(src).not.toContain("sm:w-[400px]");
  });

  it("puts CHAT_TEXT_WRAP_CLASS on every owner-facing chat bubble", () => {
    for (const rel of CHAT_BUBBLE_FILES) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, rel).toContain("CHAT_TEXT_WRAP_CLASS");
    }
  });

  it("does not leave whitespace-pre-wrap without a wrap hint", () => {
    const files = walkSource(join(ROOT, "src"));
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const re = /whitespace-pre-wrap|white-space:\s*pre-wrap/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const window = src.slice(Math.max(0, m.index - 80), m.index + 220);
        if (!WRAP_HINT.test(window)) {
          offenders.push(`${relative(ROOT, file)}:${src.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("wraps the embeddable widget and MCP transcript bubbles", () => {
    const frame = readFileSync(join(ROOT, "src/app/widget/frame/route.ts"), "utf8");
    expect(frame).toContain("overflow-wrap: anywhere");
    expect(frame).toContain("min-width: 0");
    const shell = readFileSync(join(ROOT, "src/lib/mcp/widgets/shell.ts"), "utf8");
    expect(shell).toContain("overflow-wrap:anywhere");
    expect(shell).toContain("min-width:0");
  });
});
