/**
 * Shared owner-operator context blocks
 * (src/lib/dashboard-chat/context-blocks.ts): the connected-integrations
 * ground-truth line and the business identity/memory block, provider label
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

describe("buildBusinessContextBlock, custom tables digest", () => {
  const TABLE = {
    id: "tbl-1",
    businessId: BIZ,
    name: "Properties",
    description: null,
    icon: "home" as const,
    rowLink: "standalone" as const,
    fields: [
      { id: "address", label: "Address", type: "text" as const, required: false, enabled: true }
    ],
    position: 0,
    deletedAt: null,
    createdAt: "",
    updatedAt: ""
  };

  it("names the owner's tables and their columns, so the coworker knows they exist", async () => {
    // Without this it can only learn a table exists by spending a tool call,
    // so it never volunteers "you have an Equipment table".
    const block = await buildBusinessContextBlock(BIZ, {
      fetchConfig: vi.fn(async () => ({ identity_md: "Business: X", memory_md: "" })) as never,
      fetchTables: vi.fn(async () => [TABLE]) as never,
      countRows: vi.fn(async () => new Map([["tbl-1", 42]])) as never
    });
    expect(block).toContain("# tables.md");
    expect(block).toContain("**Properties** (standalone, 42 rows): Address");
  });

  it("reads zero rows for a table the count query never mentioned", async () => {
    const block = await buildBusinessContextBlock(BIZ, {
      fetchConfig: vi.fn(async () => ({ identity_md: "X", memory_md: "" })) as never,
      fetchTables: vi.fn(async () => [TABLE]) as never,
      countRows: vi.fn(async () => new Map()) as never
    });
    expect(block).toContain("0 rows");
  });

  it("returns a block for a business that has ONLY tables", async () => {
    const block = await buildBusinessContextBlock(BIZ, {
      fetchConfig: vi.fn(async () => ({ identity_md: "", memory_md: "" })) as never,
      fetchTables: vi.fn(async () => [TABLE]) as never,
      countRows: vi.fn(async () => new Map()) as never
    });
    expect(block).toContain("# tables.md");
    expect(block).not.toContain("# identity.md");
  });

  it("skips the count query entirely when there are no tables", async () => {
    const countRows = vi.fn(async () => new Map());
    const block = await buildBusinessContextBlock(BIZ, {
      fetchConfig: vi.fn(async () => ({ identity_md: "X", memory_md: "" })) as never,
      fetchTables: vi.fn(async () => []) as never,
      countRows: countRows as never
    });
    expect(countRows).not.toHaveBeenCalled();
    expect(block).not.toContain("# tables.md");
  });

  it("keeps identity and memory when the tables read fails", async () => {
    // The tables digest is a nice-to-have; identity and memory are the
    // load-bearing half and must not go down with it.
    const block = await buildBusinessContextBlock(BIZ, {
      fetchConfig: vi.fn(async () => ({ identity_md: "Business: X", memory_md: "" })) as never,
      fetchTables: vi.fn(async () => {
        throw new Error("tables down");
      }) as never
    });
    expect(block).toContain("# identity.md");
    expect(block).not.toContain("# tables.md");
  });

  it("logs a non-Error throw without losing the block either", async () => {
    const block = await buildBusinessContextBlock(BIZ, {
      fetchConfig: vi.fn(async () => ({ identity_md: "Business: X", memory_md: "" })) as never,
      fetchTables: vi.fn(async () => {
        throw "not an error";
      }) as never
    });
    expect(block).toContain("# identity.md");
  });

  it("still returns null when everything is empty", async () => {
    expect(
      await buildBusinessContextBlock(BIZ, {
        fetchConfig: vi.fn(async () => ({ identity_md: "", memory_md: "" })) as never,
        fetchTables: vi.fn(async () => []) as never,
        countRows: vi.fn(async () => new Map()) as never
      })
    ).toBeNull();
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
