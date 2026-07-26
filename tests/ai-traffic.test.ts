import { beforeEach, describe, expect, it, vi } from "vitest";

const createServiceClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: () => createServiceClient()
}));

import {
  AI_TRAFFIC_RETENTION_DAYS,
  classifyAiTraffic,
  isTrackablePath,
  listAiTrafficRows,
  pruneAiTrafficEvents,
  recordAiTrafficEvent,
  summarizeAiTraffic,
  type AiTrafficRow
} from "@/lib/marketing/ai-traffic";

const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15";

/** Minimal supabase-js chain stub: insert / select+gte+order+limit / delete. */
function makeDb(result: { data: unknown; error: { message: string } | null }) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, ...args: unknown[]) => {
    calls[name] = args;
  };
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "gte", "order", "lt", "eq"]) {
    builder[method] = vi.fn((...args: unknown[]) => {
      record(method, ...args);
      return builder;
    });
  }
  builder.limit = vi.fn(async (...args: unknown[]) => {
    record("limit", ...args);
    return result;
  });
  builder.insert = vi.fn(async (...args: unknown[]) => {
    record("insert", ...args);
    return result;
  });
  builder.delete = vi.fn(() => {
    const del: Record<string, unknown> = {
      lt: vi.fn((...args: unknown[]) => {
        record("lt", ...args);
        return del;
      }),
      select: vi.fn(async (...args: unknown[]) => {
        record("deleteSelect", ...args);
        return result;
      })
    };
    return del;
  });
  return { db: { from: vi.fn(() => builder) } as never, calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("isTrackablePath", () => {
  it("tracks the public marketing surface", () => {
    for (const path of ["/", "/pricing", "/blog/a-post", "/compare/zinng", "/llms.txt"]) {
      expect(isTrackablePath(path)).toBe(true);
    }
  });

  it("skips everything robots.txt already disallows", () => {
    for (const path of ["/dashboard", "/admin/clients", "/api/mcp", "/oauth/consent", "/_next/x"]) {
      expect(isTrackablePath(path)).toBe(false);
    }
  });

  it("skips capability-token surfaces, whose token would land in the path column", () => {
    for (const path of ["/book/ncb_abc", "/intake/tok", "/sign/tok", "/s/abc", "/widget/frame"]) {
      expect(isTrackablePath(path)).toBe(false);
    }
  });

  it("matches whole segments, so /signup is not mistaken for the signing surface", () => {
    // /signup is one of the most important URLs we have; a bare
    // startsWith("/sign") would drop exactly the conversions being measured.
    expect(isTrackablePath("/signup")).toBe(true);
    expect(isTrackablePath("/bookkeeping-ai")).toBe(true);
    expect(isTrackablePath("/apid")).toBe(true);
    expect(isTrackablePath("/administration")).toBe(true);
  });

  it("still excludes an untracked section requested without a trailing path", () => {
    for (const path of ["/dashboard", "/admin", "/book", "/sign"]) {
      expect(isTrackablePath(path)).toBe(false);
    }
  });
});

describe("classifyAiTraffic", () => {
  it("records a crawler hit with its registry token and operator", () => {
    expect(
      classifyAiTraffic({ pathname: "/pricing", userAgent: GPTBOT, referrer: null })
    ).toEqual({ kind: "crawler", source: "GPTBot", operator: "OpenAI", path: "/pricing" });
  });

  it("records a referral from an AI answer surface", () => {
    expect(
      classifyAiTraffic({
        pathname: "/",
        userAgent: BROWSER,
        referrer: "https://chatgpt.com/c/abc"
      })
    ).toEqual({ kind: "referral", source: "ChatGPT", operator: "ChatGPT", path: "/" });
  });

  it("counts an agent that sends both as a crawler, not a human visit", () => {
    // ChatGPT-User fetches on someone's behalf and can carry a referrer.
    // Filing it as a referral would inflate the human number with robots.
    const hit = classifyAiTraffic({
      pathname: "/faq",
      userAgent: "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)",
      referrer: "https://chatgpt.com/c/abc"
    });
    expect(hit?.kind).toBe("crawler");
    expect(hit?.source).toBe("ChatGPT-User");
  });

  it("ignores ordinary traffic and untracked paths", () => {
    expect(
      classifyAiTraffic({ pathname: "/pricing", userAgent: BROWSER, referrer: "https://google.com" })
    ).toBeNull();
    expect(
      classifyAiTraffic({ pathname: "/dashboard", userAgent: GPTBOT, referrer: null })
    ).toBeNull();
    expect(classifyAiTraffic({ pathname: "/", userAgent: null, referrer: null })).toBeNull();
  });
});

describe("recordAiTrafficEvent", () => {
  const event = {
    kind: "crawler" as const,
    source: "GPTBot",
    operator: "OpenAI",
    path: "/pricing"
  };

  it("inserts the event", async () => {
    const { db, calls } = makeDb({ data: null, error: null });
    await recordAiTrafficEvent(event, db);
    expect(calls.insert[0]).toEqual(event);
  });

  it("never throws on a DB error, since logging must not break a page", async () => {
    const { db } = makeDb({ data: null, error: { message: "permission denied" } });
    await expect(recordAiTrafficEvent(event, db)).resolves.toBeUndefined();
  });

  it.each([
    ["an Error", new Error("no connection")],
    ["a bare string", "no connection"]
  ])("never throws when the client itself blows up with %s", async (_label, thrown) => {
    const exploding = {
      from: () => {
        throw thrown;
      }
    } as never;
    await expect(recordAiTrafficEvent(event, exploding)).resolves.toBeUndefined();
  });
});

describe("listAiTrafficRows", () => {
  it("reads the window newest-first, bounded", async () => {
    const rows: AiTrafficRow[] = [
      {
        kind: "crawler",
        source: "GPTBot",
        operator: "OpenAI",
        path: "/",
        created_at: "2026-07-20T00:00:00.000Z"
      }
    ];
    const { db, calls } = makeDb({ data: rows, error: null });
    expect(await listAiTrafficRows("2026-07-01T00:00:00.000Z", 100, db)).toEqual(rows);
    expect(calls.gte).toEqual(["created_at", "2026-07-01T00:00:00.000Z"]);
    expect(calls.limit).toEqual([100]);
  });

  it("returns an empty list when the query yields nothing", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(await listAiTrafficRows("2026-07-01T00:00:00.000Z", 10, db)).toEqual([]);
  });

  it("throws on a read error, so the admin page shows a failure not a lie", async () => {
    const { db } = makeDb({ data: null, error: { message: "boom" } });
    await expect(listAiTrafficRows("2026-07-01T00:00:00.000Z", 10, db)).rejects.toThrow(
      "listAiTrafficRows: boom"
    );
  });
});

describe("pruneAiTrafficEvents", () => {
  const now = new Date("2026-07-26T12:00:00.000Z");

  it("deletes past the fixed window and returns the count", async () => {
    const { db, calls } = makeDb({ data: [{ id: "1" }, { id: "2" }], error: null });
    expect(await pruneAiTrafficEvents(now, db)).toBe(2);
    const cutoff = new Date(
      now.getTime() - AI_TRAFFIC_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    expect(calls.lt).toEqual(["created_at", cutoff]);
  });

  it("reports zero when the delete returns no rows", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(await pruneAiTrafficEvents(now, db)).toBe(0);
  });

  it("throws on a delete error so the sweep records it", async () => {
    const { db } = makeDb({ data: null, error: { message: "locked" } });
    await expect(pruneAiTrafficEvents(now, db)).rejects.toThrow("pruneAiTrafficEvents: locked");
  });
});

describe("summarizeAiTraffic", () => {
  const now = new Date("2026-07-05T12:00:00.000Z");
  const since = "2026-07-03T00:00:00.000Z";

  function row(over: Partial<AiTrafficRow>): AiTrafficRow {
    return {
      kind: "crawler",
      source: "GPTBot",
      operator: "OpenAI",
      path: "/pricing",
      created_at: "2026-07-04T09:00:00.000Z",
      ...over
    };
  }

  it("totals each kind and buckets by UTC day", () => {
    const summary = summarizeAiTraffic(
      [
        row({}),
        row({ source: "ClaudeBot", operator: "Anthropic" }),
        row({
          kind: "referral",
          source: "ChatGPT",
          operator: "ChatGPT",
          created_at: "2026-07-05T01:00:00.000Z"
        })
      ],
      since,
      now
    );

    expect(summary.crawlerHits).toBe(2);
    expect(summary.referrals).toBe(1);
    expect(summary.byDay).toEqual([
      { day: "2026-07-03", crawler: 0, referral: 0 },
      { day: "2026-07-04", crawler: 2, referral: 0 },
      { day: "2026-07-05", crawler: 0, referral: 1 }
    ]);
  });

  it("zero-fills quiet days so the trend does not lie by omission", () => {
    const summary = summarizeAiTraffic([], since, now);
    expect(summary.byDay.map((d) => d.day)).toEqual([
      "2026-07-03",
      "2026-07-04",
      "2026-07-05"
    ]);
    expect(summary.byDay.every((d) => d.crawler === 0 && d.referral === 0)).toBe(true);
    expect(summary.crawlerOperators).toEqual([]);
    expect(summary.topSources).toEqual([]);
    expect(summary.topPaths).toEqual([]);
  });

  it("still totals a row that falls outside the rendered day range", () => {
    const summary = summarizeAiTraffic([row({ created_at: "2026-06-01T00:00:00.000Z" })], since, now);
    expect(summary.crawlerHits).toBe(1);
    expect(summary.byDay.every((d) => d.crawler === 0)).toBe(true);
  });

  it("ranks sources and paths by count, breaking ties stably by name", () => {
    const summary = summarizeAiTraffic(
      [
        row({ source: "PerplexityBot", operator: "Perplexity", path: "/faq" }),
        row({ source: "ClaudeBot", operator: "Anthropic", path: "/pricing" }),
        row({ source: "ClaudeBot", operator: "Anthropic", path: "/pricing" }),
        row({ source: "GPTBot", path: "/faq" })
      ],
      since,
      now
    );

    expect(summary.topSources).toEqual([
      { source: "ClaudeBot", kind: "crawler", count: 2 },
      { source: "GPTBot", kind: "crawler", count: 1 },
      { source: "PerplexityBot", kind: "crawler", count: 1 }
    ]);
    expect(summary.topPaths).toEqual([
      { path: "/faq", count: 2 },
      { path: "/pricing", count: 2 }
    ]);
  });

  it("lists crawler operators alphabetically, and only for crawler rows", () => {
    const summary = summarizeAiTraffic(
      [
        row({ operator: "Perplexity" }),
        row({ operator: "Anthropic" }),
        row({ kind: "referral", source: "Claude", operator: "Claude" })
      ],
      since,
      now
    );
    expect(summary.crawlerOperators).toEqual(["Anthropic", "Perplexity"]);
  });

  it("caps the day range instead of spinning on a nonsense window", () => {
    const summary = summarizeAiTraffic([], "1990-01-01T00:00:00.000Z", now);
    expect(summary.byDay).toHaveLength(400);
  });

  it("keeps only the top ten of each ranking", () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      row({ source: `Bot${i}`, path: `/p${i}` })
    );
    const summary = summarizeAiTraffic(rows, since, now);
    expect(summary.topSources).toHaveLength(10);
    expect(summary.topPaths).toHaveLength(10);
  });

  it("defaults the clock to now when the caller does not pass one", () => {
    const summary = summarizeAiTraffic([], new Date().toISOString());
    expect(summary.byDay.length).toBeGreaterThanOrEqual(1);
  });
});

describe("default service client", () => {
  // Production callers pass no client. Exercising that path proves the
  // service-role wiring is real rather than only ever stubbed.
  it("is resolved by every DB function that takes an optional client", async () => {
    const { db, calls } = makeDb({ data: [{ id: "1" }], error: null });
    createServiceClient.mockResolvedValue(db);

    await recordAiTrafficEvent({
      kind: "referral",
      source: "Claude",
      operator: "Claude",
      path: "/"
    });
    expect(calls.insert[0]).toMatchObject({ source: "Claude" });

    await listAiTrafficRows("2026-07-01T00:00:00.000Z");
    expect(calls.limit).toEqual([5000]);

    // No clock argument either: the prune defaults to the current time.
    expect(await pruneAiTrafficEvents()).toBe(1);
    expect(createServiceClient).toHaveBeenCalledTimes(3);
  });
});
