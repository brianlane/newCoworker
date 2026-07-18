import { describe, expect, it } from "vitest";
import { smsLinkClicksCsv, smsLinksCsv } from "@/lib/analytics/export";
import { parseCsv } from "@/lib/csv/csv";

describe("smsLinksCsv", () => {
  it("writes one row per tracked link", () => {
    const csv = smsLinksCsv([
      {
        shortCode: "36q72wrm",
        originalUrl: "https://calendly.com/kyp/strategy",
        toE164: "+16478879033",
        flowName: "Lead follow-up",
        clickCount: 3,
        firstClickedAt: "2026-07-17T19:25:00.000Z",
        lastClickedAt: "2026-07-17T20:01:00.000Z",
        createdAt: "2026-07-17T19:24:50.000Z"
      }
    ]);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows[0]?.short_code).toBe("36q72wrm");
    expect(parsed.rows[0]?.clicks).toBe("3");
  });
});

describe("smsLinksCsv clipped note", () => {
  it("appends partial-counts note when clipped", () => {
    expect(smsLinksCsv([], true)).toMatch(/most recent activity only/);
  });
});

describe("smsLinksCsv null fields", () => {
  it("renders empty cells for missing recipient/flow/click timestamps", () => {
    const csv = smsLinksCsv([
      {
        shortCode: "abc12345",
        originalUrl: "https://example.com",
        toE164: null,
        flowName: null,
        clickCount: 0,
        firstClickedAt: null,
        lastClickedAt: null,
        createdAt: "2026-07-17T19:24:50.000Z"
      }
    ]);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows[0]?.recipient).toBe("");
    expect(parsed.rows[0]?.flow).toBe("");
    expect(parsed.rows[0]?.first_click).toBe("");
    expect(parsed.rows[0]?.last_click).toBe("");
  });
});

describe("smsLinkClicksCsv", () => {
  it("writes one row per click event with the prefetch flag", () => {
    const csv = smsLinkClicksCsv([
      {
        clickedAt: "2026-07-17T19:25:00.000Z",
        shortCode: "36q72wrm",
        originalUrl: "https://calendly.com/kyp/strategy",
        toE164: "+16478879033",
        flowId: "flow-1",
        runId: "run-1",
        likelyPrefetch: false
      },
      {
        clickedAt: "2026-07-17T19:25:05.000Z",
        shortCode: "36q72wrm",
        originalUrl: "https://calendly.com/kyp/strategy",
        toE164: "+16478879033",
        flowId: "flow-1",
        runId: "run-1",
        likelyPrefetch: true
      }
    ]);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows[0]?.short_code).toBe("36q72wrm");
    expect(parsed.rows[0]?.run_id).toBe("run-1");
    expect(parsed.rows[0]?.likely_prefetch).toBe("no");
    expect(parsed.rows[1]?.likely_prefetch).toBe("yes");
  });

  it("appends partial-counts note when clipped", () => {
    expect(smsLinkClicksCsv([], true)).toMatch(/most recent activity only/);
  });

  it("renders empty cells for missing recipient/flow/run", () => {
    const csv = smsLinkClicksCsv([
      {
        clickedAt: "2026-07-17T19:25:00.000Z",
        shortCode: "abc12345",
        originalUrl: "https://example.com",
        toE164: null,
        flowId: null,
        runId: null,
        likelyPrefetch: false
      }
    ]);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows[0]?.recipient).toBe("");
    expect(parsed.rows[0]?.flow_id).toBe("");
    expect(parsed.rows[0]?.run_id).toBe("");
  });
});
