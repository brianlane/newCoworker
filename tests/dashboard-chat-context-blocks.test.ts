/**
 * Shared owner-operator context blocks
 * (src/lib/dashboard-chat/context-blocks.ts): the connected-integrations
 * ground-truth line and the business identity/memory block — provider label
 * arms, clipping, and the best-effort failure contract. Used by BOTH the
 * dashboard chat route and the owner-over-SMS turn.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  BUSINESS_CONTEXT_MAX_CHARS,
  buildBusinessContextBlock,
  buildIntegrationsStatusLine
} from "@/lib/dashboard-chat/context-blocks";

const BIZ = "11111111-1111-4111-8111-111111111111";

describe("buildIntegrationsStatusLine", () => {
  it("labels every calendar provider arm and both mailbox arms", async () => {
    for (const [provider, needle] of [
      ["calendly", "cannot book on their behalf"],
      ["vagaro", "Vagaro"],
      ["google", "Google Calendar"],
      ["microsoft", "Outlook Calendar"],
      ["caldav", "CalDAV"],
      ["something-new", "something-new"] // unknown provider falls back to the raw key
    ] as const) {
      const line = await buildIntegrationsStatusLine(BIZ, {
        resolveCalendar: vi.fn(async () => ({ provider })) as never,
        resolveEmail: vi.fn(async () => ({ provider: "microsoft" })) as never
      });
      expect(line).toContain(needle);
      expect(line).toContain("Microsoft mailbox connected");
    }

    const googleMail = await buildIntegrationsStatusLine(BIZ, {
      resolveCalendar: vi.fn(async () => null) as never,
      resolveEmail: vi.fn(async () => ({ provider: "google" })) as never
    });
    expect(googleMail).toContain("Calendar: not connected");
    expect(googleMail).toContain("Google mailbox connected");

    const nothing = await buildIntegrationsStatusLine(BIZ, {
      resolveCalendar: vi.fn(async () => null) as never,
      resolveEmail: vi.fn(async () => null) as never
    });
    expect(nothing).toContain("Email mailbox: not connected");
    expect(nothing).toContain("never guess");
  });

  it("degrades to null when a resolver throws (Error and non-Error)", async () => {
    for (const thrown of [new Error("nango down"), "string blast"]) {
      const line = await buildIntegrationsStatusLine(BIZ, {
        resolveCalendar: vi.fn(async () => {
          throw thrown;
        }) as never,
        resolveEmail: vi.fn(async () => null) as never
      });
      expect(line).toBeNull();
    }
  });
});

describe("buildBusinessContextBlock", () => {
  it("includes identity (head-clipped) and memory (tail-clipped)", async () => {
    const longIdentity = "I".repeat(BUSINESS_CONTEXT_MAX_CHARS + 50);
    const longMemory = `OLD-${"M".repeat(BUSINESS_CONTEXT_MAX_CHARS + 50)}NEWEST`;
    const block = await buildBusinessContextBlock(BIZ, {
      fetchConfig: vi.fn(async () => ({
        identity_md: longIdentity,
        memory_md: longMemory
      })) as never
    });
    expect(block).toContain("YOUR BUSINESS CONFIGURATION");
    expect(block).toContain("… (truncated)");
    expect(block).toContain("… (older content truncated)");
    // Tail clip keeps the newest memory content.
    expect(block).toContain("NEWEST");
    expect(block).not.toContain("OLD-");
  });

  it("handles identity-only, memory-only, and empty configs", async () => {
    const identityOnly = await buildBusinessContextBlock(BIZ, {
      fetchConfig: vi.fn(async () => ({ identity_md: "Business: X", memory_md: "" })) as never
    });
    expect(identityOnly).toContain("# identity.md");
    expect(identityOnly).not.toContain("# memory.md");

    const memoryOnly = await buildBusinessContextBlock(BIZ, {
      fetchConfig: vi.fn(async () => ({ identity_md: "  ", memory_md: "- rule" })) as never
    });
    expect(memoryOnly).toContain("# memory.md");
    expect(memoryOnly).not.toContain("# identity.md");

    expect(
      await buildBusinessContextBlock(BIZ, {
        fetchConfig: vi.fn(async () => ({ identity_md: "", memory_md: "" })) as never
      })
    ).toBeNull();
    expect(
      await buildBusinessContextBlock(BIZ, {
        fetchConfig: vi.fn(async () => null) as never
      })
    ).toBeNull();
    // Nullish fields tolerated.
    expect(
      await buildBusinessContextBlock(BIZ, {
        fetchConfig: vi.fn(async () => ({})) as never
      })
    ).toBeNull();
  });

  it("degrades to null when the config read throws (Error and non-Error)", async () => {
    for (const thrown of [new Error("db down"), 42]) {
      expect(
        await buildBusinessContextBlock(BIZ, {
          fetchConfig: vi.fn(async () => {
            throw thrown;
          }) as never
        })
      ).toBeNull();
    }
  });
});
