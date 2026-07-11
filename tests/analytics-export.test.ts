import { describe, expect, it } from "vitest";

import { dailySeriesCsv, flowFunnelsCsv } from "@/lib/analytics/export";
import { parseCsv } from "@/lib/csv/csv";

describe("dailySeriesCsv", () => {
  it("writes one row per day plus a totals row", () => {
    const csv = dailySeriesCsv([
      { date: "2026-07-01", calls: 3, sms: 10, voiceMinutes: 5 },
      { date: "2026-07-02", calls: 0, sms: 2, voiceMinutes: 0 }
    ]);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.headers).toEqual(["date", "calls", "texts", "voice_minutes"]);
    expect(parsed.rows).toEqual([
      { date: "2026-07-01", calls: "3", texts: "10", voice_minutes: "5" },
      { date: "2026-07-02", calls: "0", texts: "2", voice_minutes: "0" },
      { date: "total", calls: "3", texts: "12", voice_minutes: "5" }
    ]);
  });

  it("an empty series still yields headers + a zero totals row", () => {
    const parsed = parseCsv(dailySeriesCsv([]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows).toEqual([
      { date: "total", calls: "0", texts: "0", voice_minutes: "0" }
    ]);
  });
});

describe("flowFunnelsCsv", () => {
  it("writes one row per flow with quoting-safe names", () => {
    const csv = flowFunnelsCsv([
      {
        flowId: "f1",
        flowName: 'Lead "hot" follow-up, v2',
        enabled: true,
        runs: 7,
        textsSent: 5,
        linksClicked: 2,
        linkClicks: 4,
        goalsReached: 1
      },
      {
        flowId: "f2",
        flowName: "Idle",
        enabled: false,
        runs: 0,
        textsSent: 0,
        linksClicked: 0,
        linkClicks: 0,
        goalsReached: 0
      }
    ]);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.headers).toEqual([
      "flow",
      "enabled",
      "runs",
      "texts_sent",
      "links_clicked",
      "link_clicks",
      "goals_reached"
    ]);
    expect(parsed.rows[0]).toEqual({
      flow: 'Lead "hot" follow-up, v2',
      enabled: "yes",
      runs: "7",
      texts_sent: "5",
      links_clicked: "2",
      link_clicks: "4",
      goals_reached: "1"
    });
    expect(parsed.rows[1].enabled).toBe("no");
  });
});
