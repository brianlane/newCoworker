import { beforeEach, describe, expect, it, vi } from "vitest";

const { defaultClientSpy, resolveContactNames } = vi.hoisted(() => ({
  defaultClientSpy: vi.fn(),
  resolveContactNames: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => defaultClientSpy(...a)
}));

vi.mock("@/lib/db/contact-names", () => ({ resolveContactNames }));

import {
  DEFAULT_LINK_CLICKS_LIMIT,
  listClickEventsForLink,
  listSmsLinksByOutboundLogIds,
  listSmsLinksForBusiness,
  listSmsLinksForContact,
  listSmsLinksForFlow,
  listSmsLinksForRun,
  mapSmsLinksByOutboundLogIds
} from "@/lib/db/sms-links";
import {
  getSmsLinkStats,
  listLinkClickEventsForBusiness
} from "@/lib/analytics/sms-link-stats";

type Result = { data: unknown; error: { message: string } | null };

/**
 * Thenable query builder mirroring supabase-js: every method returns the
 * builder, awaiting at any point resolves the configured result.
 */
function builder(result: Result) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "in", "order", "limit"]) {
    b[m] = vi.fn(() => b);
  }
  b.then = (
    resolve: (v: Result) => unknown,
    reject?: (e: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);
  return b as Record<string, ReturnType<typeof vi.fn>> & PromiseLike<Result>;
}

/** Routes each table to a queue of builders (last one repeats). */
function makeDb(routes: Record<string, unknown[]>) {
  return {
    from: vi.fn((table: string) => {
      const queue = routes[table];
      if (!queue || queue.length === 0) throw new Error(`unexpected table ${table}`);
      return queue.length > 1 ? queue.shift() : queue[0];
    })
  };
}

const linkRow = {
  id: "link-1",
  business_id: "biz-1",
  short_code: "36q72wrm",
  original_url: "https://calendly.com/kyp/strategy",
  to_e164: "+16478879033",
  source: "ai_flow",
  flow_id: "flow-1",
  run_id: "run-1",
  sms_outbound_log_id: "log-1",
  click_count: 3,
  first_clicked_at: "2026-07-17T19:25:00.000Z",
  last_clicked_at: "2026-07-17T20:01:00.000Z",
  created_at: "2026-07-17T19:24:50.000Z"
};

const flowRows = { data: [{ id: "flow-1", name: "Lead follow-up" }], error: null };
const clickRows = {
  data: [{ id: "c1", link_id: "link-1", clicked_at: "2026-07-17T19:25:00.000Z" }],
  error: null
};

beforeEach(() => {
  defaultClientSpy.mockReset();
  resolveContactNames.mockReset();
  resolveContactNames.mockResolvedValue(new Map([["+16478879033", { name: "Muhammad al" }]]));
  process.env.NEXT_PUBLIC_APP_URL = "https://www.newcoworker.com";
});

describe("listSmsLinksForContact", () => {
  it("returns enriched links with clicks via the default client", async () => {
    const db = makeDb({
      sms_links: [builder({ data: [linkRow], error: null })],
      ai_flows: [builder(flowRows)],
      sms_link_clicks: [builder(clickRows)]
    });
    defaultClientSpy.mockResolvedValue(db);

    const rows = await listSmsLinksForContact("biz-1", "+16478879033", { includeClicks: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].contactName).toBe("Muhammad al");
    expect(rows[0].flowName).toBe("Lead follow-up");
    expect(rows[0].shortUrl).toBe("https://www.newcoworker.com/s/36q72wrm");
    expect(rows[0].clicks).toHaveLength(1);
  });

  it("accepts an explicit window and pinned now", async () => {
    const db = makeDb({
      sms_links: [builder({ data: [], error: null })]
    });
    const rows = await listSmsLinksForContact("biz-1", "+100", {
      client: db as never,
      days: 7,
      now: new Date("2026-07-17T00:00:00Z")
    });
    expect(rows).toEqual([]);
  });

  it("throws on a query error", async () => {
    const db = makeDb({
      sms_links: [builder({ data: null, error: { message: "denied" } })]
    });
    await expect(
      listSmsLinksForContact("biz-1", "+16478879033", { client: db as never })
    ).rejects.toThrow("listSmsLinksForContact: denied");
  });

  it("tolerates a null data payload", async () => {
    const db = makeDb({ sms_links: [builder({ data: null, error: null })] });
    expect(
      await listSmsLinksForContact("biz-1", "+100", { client: db as never })
    ).toEqual([]);
  });
});

describe("link enrichment", () => {
  it("handles null recipient / flow and a missing app URL", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const bare = { ...linkRow, to_e164: null, flow_id: null };
    const db = makeDb({ sms_links: [builder({ data: [bare], error: null })] });
    const rows = await listSmsLinksForContact("biz-1", "+100", { client: db as never });
    expect(rows[0].contactName).toBeNull();
    expect(rows[0].flowName).toBeNull();
    expect(rows[0].shortUrl).toBe("http://localhost:3000/s/36q72wrm");
    expect(resolveContactNames).not.toHaveBeenCalled();
  });

  it("tolerates a contact-name lookup failure and an unknown flow id", async () => {
    resolveContactNames.mockRejectedValue(new Error("names down"));
    const strayFlow = { ...linkRow, flow_id: "flow-unknown" };
    const db = makeDb({
      sms_links: [builder({ data: [strayFlow], error: null })],
      ai_flows: [builder({ data: [], error: null })]
    });
    const rows = await listSmsLinksForContact("biz-1", "+16478879033", { client: db as never });
    expect(rows[0].contactName).toBeNull();
    expect(rows[0].flowName).toBeNull();
  });

  it("tolerates null data payloads from the flow-name and click-event lookups", async () => {
    const db = makeDb({
      sms_links: [builder({ data: [linkRow], error: null })],
      ai_flows: [builder({ data: null, error: null })],
      sms_link_clicks: [builder({ data: null, error: null })]
    });
    const rows = await listSmsLinksForContact("biz-1", "+16478879033", {
      client: db as never,
      includeClicks: true
    });
    expect(rows[0].flowName).toBeNull();
    expect(rows[0].clicks).toEqual([]);
  });

  it("returns null contactName when the resolver has no entry for the number", async () => {
    resolveContactNames.mockResolvedValue(new Map());
    const db = makeDb({
      sms_links: [builder({ data: [linkRow], error: null })],
      ai_flows: [builder(flowRows)]
    });
    const rows = await listSmsLinksForContact("biz-1", "+16478879033", { client: db as never });
    expect(rows[0].contactName).toBeNull();
  });

  it("throws when the flow-name lookup fails", async () => {
    const db = makeDb({
      sms_links: [builder({ data: [linkRow], error: null })],
      ai_flows: [builder({ data: null, error: { message: "flows down" } })]
    });
    await expect(
      listSmsLinksForContact("biz-1", "+16478879033", { client: db as never })
    ).rejects.toThrow("fetchFlowNames: flows down");
  });

  it("throws when the click-events lookup fails", async () => {
    const db = makeDb({
      sms_links: [builder({ data: [linkRow], error: null })],
      ai_flows: [builder(flowRows)],
      sms_link_clicks: [builder({ data: null, error: { message: "clicks down" } })]
    });
    await expect(
      listSmsLinksForContact("biz-1", "+16478879033", {
        client: db as never,
        includeClicks: true
      })
    ).rejects.toThrow("fetchClickEvents: clicks down");
  });

  it("caps the per-link click timeline at the limit", async () => {
    const many = Array.from({ length: DEFAULT_LINK_CLICKS_LIMIT + 5 }, (_, i) => ({
      id: `c-${i}`,
      link_id: "link-1",
      clicked_at: `2026-07-17T19:${String(i).padStart(2, "0")}:00.000Z`
    }));
    const db = makeDb({
      sms_links: [builder({ data: [linkRow], error: null })],
      ai_flows: [builder(flowRows)],
      sms_link_clicks: [builder({ data: many, error: null })]
    });
    const rows = await listSmsLinksForContact("biz-1", "+16478879033", {
      client: db as never,
      includeClicks: true
    });
    expect(rows[0].clicks).toHaveLength(DEFAULT_LINK_CLICKS_LIMIT);
  });
});

describe("listClickEventsForLink", () => {
  it("returns events via the default client with the default limit", async () => {
    const clicks = builder(clickRows);
    defaultClientSpy.mockResolvedValue(makeDb({ sms_link_clicks: [clicks] }));
    const rows = await listClickEventsForLink("link-1");
    expect(rows).toHaveLength(1);
    expect(clicks.limit).toHaveBeenCalledWith(DEFAULT_LINK_CLICKS_LIMIT);
  });

  it("honors an explicit client and limit, and throws on error", async () => {
    const clicks = builder(clickRows);
    const db = makeDb({ sms_link_clicks: [clicks] });
    await listClickEventsForLink("link-1", { client: db as never, limit: 5 });
    expect(clicks.limit).toHaveBeenCalledWith(5);

    const errDb = makeDb({
      sms_link_clicks: [builder({ data: null, error: { message: "denied" } })]
    });
    await expect(
      listClickEventsForLink("link-1", { client: errDb as never })
    ).rejects.toThrow("listClickEventsForLink: denied");
  });

  it("tolerates a null data payload", async () => {
    const db = makeDb({ sms_link_clicks: [builder({ data: null, error: null })] });
    expect(await listClickEventsForLink("link-1", { client: db as never })).toEqual([]);
  });
});

describe("listSmsLinksByOutboundLogIds", () => {
  it("no-ops on empty or all-falsy ids without touching the db", async () => {
    expect(await listSmsLinksByOutboundLogIds("biz-1", [])).toEqual([]);
    expect(await listSmsLinksByOutboundLogIds("biz-1", ["", ""])).toEqual([]);
    expect(defaultClientSpy).not.toHaveBeenCalled();
  });

  it("uses the default client and tolerates a null data payload", async () => {
    const db = makeDb({ sms_links: [builder({ data: null, error: null })] });
    defaultClientSpy.mockResolvedValue(db);
    expect(await listSmsLinksByOutboundLogIds("biz-1", ["log-1"])).toEqual([]);
    expect(defaultClientSpy).toHaveBeenCalled();
  });

  it("throws on a query error", async () => {
    const db = makeDb({
      sms_links: [builder({ data: null, error: { message: "denied" } })]
    });
    await expect(
      listSmsLinksByOutboundLogIds("biz-1", ["log-1"], { client: db as never })
    ).rejects.toThrow("listSmsLinksByOutboundLogIds: denied");
  });
});

describe("mapSmsLinksByOutboundLogIds", () => {
  it("groups links by outbound log id and skips unpaired rows", async () => {
    const unpaired = { ...linkRow, id: "link-2", sms_outbound_log_id: null };
    const db = makeDb({
      sms_links: [builder({ data: [linkRow, unpaired], error: null })],
      ai_flows: [builder(flowRows)]
    });
    defaultClientSpy.mockResolvedValue(db);
    const map = await mapSmsLinksByOutboundLogIds("biz-1", ["log-1"], { client: db as never });
    expect(map.get("log-1")).toHaveLength(1);
    expect(map.size).toBe(1);
  });
});

describe("listSmsLinksForRun", () => {
  it("loads run links via the default client", async () => {
    const db = makeDb({
      sms_links: [builder({ data: [linkRow], error: null })],
      ai_flows: [builder(flowRows)]
    });
    defaultClientSpy.mockResolvedValue(db);
    const rows = await listSmsLinksForRun("biz-1", "run-1");
    expect(rows[0].short_code).toBe("36q72wrm");
  });

  it("throws on a query error and tolerates a null data payload", async () => {
    const errDb = makeDb({
      sms_links: [builder({ data: null, error: { message: "denied" } })]
    });
    await expect(
      listSmsLinksForRun("biz-1", "run-1", { client: errDb as never })
    ).rejects.toThrow("listSmsLinksForRun: denied");

    const nullDb = makeDb({ sms_links: [builder({ data: null, error: null })] });
    expect(await listSmsLinksForRun("biz-1", "run-1", { client: nullDb as never })).toEqual([]);
  });
});

describe("listSmsLinksForFlow", () => {
  it("loads raw flow rows via the default client (no enrichment)", async () => {
    const db = makeDb({ sms_links: [builder({ data: [linkRow], error: null })] });
    defaultClientSpy.mockResolvedValue(db);
    const rows = await listSmsLinksForFlow("biz-1", "flow-1");
    expect(rows[0].flow_id).toBe("flow-1");
  });

  it("accepts an explicit window and throws on error", async () => {
    const db = makeDb({ sms_links: [builder({ data: [], error: null })] });
    expect(
      await listSmsLinksForFlow("biz-1", "flow-1", {
        client: db as never,
        days: 7,
        now: new Date("2026-07-17T00:00:00Z")
      })
    ).toEqual([]);

    const errDb = makeDb({
      sms_links: [builder({ data: null, error: { message: "denied" } })]
    });
    await expect(
      listSmsLinksForFlow("biz-1", "flow-1", { client: errDb as never })
    ).rejects.toThrow("listSmsLinksForFlow: denied");

    const nullDb = makeDb({ sms_links: [builder({ data: null, error: null })] });
    expect(await listSmsLinksForFlow("biz-1", "flow-1", { client: nullDb as never })).toEqual([]);
  });
});

describe("listSmsLinksForBusiness", () => {
  it("filters by flowId when provided", async () => {
    const links = builder({ data: [linkRow], error: null });
    const db = makeDb({ sms_links: [links], ai_flows: [builder(flowRows)] });
    const rows = await listSmsLinksForBusiness("biz-1", {
      flowId: "flow-1",
      client: db as never
    });
    expect(rows[0].flowName).toBe("Lead follow-up");
    expect(links.eq).toHaveBeenCalledWith("flow_id", "flow-1");
  });

  it("uses the default client and window when no options are given", async () => {
    const db = makeDb({
      sms_links: [builder({ data: [linkRow], error: null })],
      ai_flows: [builder(flowRows)]
    });
    defaultClientSpy.mockResolvedValue(db);
    const rows = await listSmsLinksForBusiness("biz-1");
    expect(rows).toHaveLength(1);
  });

  it("honors explicit days/limit/now and throws on error", async () => {
    const links = builder({ data: [], error: null });
    const db = makeDb({ sms_links: [links] });
    await listSmsLinksForBusiness("biz-1", {
      client: db as never,
      days: 7,
      limit: 10,
      now: new Date("2026-07-17T00:00:00Z")
    });
    expect(links.limit).toHaveBeenCalledWith(10);

    const errDb = makeDb({
      sms_links: [builder({ data: null, error: { message: "denied" } })]
    });
    await expect(
      listSmsLinksForBusiness("biz-1", { client: errDb as never })
    ).rejects.toThrow("listSmsLinksForBusiness: denied");

    const nullDb = makeDb({ sms_links: [builder({ data: null, error: null })] });
    expect(await listSmsLinksForBusiness("biz-1", { client: nullDb as never })).toEqual([]);
  });
});

describe("getSmsLinkStats", () => {
  it("marks clipped when the scan exceeds the cap", async () => {
    const scan = builder({
      data: Array.from({ length: 501 }, (_, i) => ({ id: `id-${i}` })),
      error: null
    });
    const db = makeDb({
      sms_links: [scan, builder({ data: [linkRow], error: null })],
      ai_flows: [builder(flowRows)],
      sms_link_clicks: [builder({ data: [], error: null })]
    });
    const stats = await getSmsLinkStats("biz-1", { client: db as never });
    expect(stats.clipped).toBe(true);
    expect(stats.links).toHaveLength(1);
  });

  it("uses the default client and filters by flowId", async () => {
    const scan = builder({ data: [{ id: "link-1" }], error: null });
    const db = makeDb({
      sms_links: [scan, builder({ data: [linkRow], error: null })],
      ai_flows: [builder(flowRows)],
      sms_link_clicks: [builder({ data: [], error: null })]
    });
    defaultClientSpy.mockResolvedValue(db);
    const stats = await getSmsLinkStats("biz-1", {
      flowId: "flow-1",
      days: 7,
      now: new Date("2026-07-17T00:00:00Z")
    });
    expect(stats.clipped).toBe(false);
    expect(scan.eq).toHaveBeenCalledWith("flow_id", "flow-1");
  });

  it("treats a null scan payload as unclipped", async () => {
    const db = makeDb({
      sms_links: [
        builder({ data: null, error: null }),
        builder({ data: [], error: null })
      ]
    });
    const stats = await getSmsLinkStats("biz-1", { client: db as never });
    expect(stats).toEqual({ links: [], clipped: false });
  });

  it("throws on a scan error", async () => {
    const db = makeDb({
      sms_links: [builder({ data: null, error: { message: "denied" } })]
    });
    await expect(getSmsLinkStats("biz-1", { client: db as never })).rejects.toThrow(
      "getSmsLinkStats scan: denied"
    );
  });
});

describe("listLinkClickEventsForBusiness", () => {
  it("returns click rows joined to link metadata via the default client", async () => {
    const straggler = { id: "c2", link_id: "link-gone", clicked_at: "2026-07-17T19:26:00.000Z" };
    const db = makeDb({
      sms_links: [
        builder({ data: [{ id: "link-1" }], error: null }),
        builder({ data: [linkRow], error: null })
      ],
      ai_flows: [builder(flowRows)],
      sms_link_clicks: [
        builder({ data: [], error: null }),
        builder({ data: [...(clickRows.data as unknown[]), straggler], error: null })
      ]
    });
    defaultClientSpy.mockResolvedValue(db);

    const events = await listLinkClickEventsForBusiness("biz-1");
    expect(events[0].short_code).toBe("36q72wrm");
    expect(events[0].run_id).toBe("run-1");
    // A click whose link fell out of the window degrades to empty metadata.
    expect(events[1].short_code).toBe("");
    expect(events[1].to_e164).toBeNull();
  });

  it("tolerates a null click payload", async () => {
    const db = makeDb({
      sms_links: [
        builder({ data: [{ id: "link-1" }], error: null }),
        builder({ data: [linkRow], error: null })
      ],
      ai_flows: [builder(flowRows)],
      sms_link_clicks: [
        builder({ data: [], error: null }),
        builder({ data: null, error: null })
      ]
    });
    const events = await listLinkClickEventsForBusiness("biz-1", { client: db as never });
    expect(events).toEqual([]);
  });

  it("returns [] when no links exist in the window", async () => {
    const db = makeDb({
      sms_links: [
        builder({ data: [], error: null }),
        builder({ data: [], error: null })
      ]
    });
    const events = await listLinkClickEventsForBusiness("biz-1", { client: db as never });
    expect(events).toEqual([]);
  });

  it("honors explicit options and throws on a clicks error", async () => {
    const clicks = builder({ data: null, error: { message: "denied" } });
    const db = makeDb({
      sms_links: [
        builder({ data: [{ id: "link-1" }], error: null }),
        builder({ data: [linkRow], error: null })
      ],
      ai_flows: [builder(flowRows)],
      sms_link_clicks: [builder({ data: [], error: null }), clicks]
    });
    await expect(
      listLinkClickEventsForBusiness("biz-1", {
        client: db as never,
        days: 7,
        limit: 100,
        flowId: "flow-1",
        now: new Date("2026-07-17T00:00:00Z")
      })
    ).rejects.toThrow("listLinkClickEventsForBusiness: denied");
    expect(clicks.limit).toHaveBeenCalledWith(100);
  });
});
