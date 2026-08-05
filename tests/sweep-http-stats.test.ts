import { describe, expect, it } from "vitest";
import {
  bodySignature,
  extractDurationMs,
  percentile,
  summarizeResponses,
  type HttpResponseRow
} from "../src/lib/cron/sweep-http-stats";

/**
 * The measurement layer for debug/cron-http-stats.ts.
 *
 * pg_net's http_post is asynchronous: the cron run only enqueues the request,
 * so cron.job_run_details knows nothing about how the chain went. The real
 * outcomes sit in net._http_response for ~6 hours, with no job column. These
 * helpers turn those rows into per-route stats, attributing by the JSON shape
 * each route returns and reading the route's own durationMs.
 */

function row(over: Partial<HttpResponseRow>): HttpResponseRow {
  return {
    statusCode: 200,
    timedOut: false,
    errorMsg: null,
    contentType: "application/json",
    content: '{"ok":true}',
    created: new Date("2026-08-05T12:00:00Z"),
    ...over
  };
}

describe("bodySignature", () => {
  it("uses the sorted keys of the data envelope when present", () => {
    expect(bodySignature('{"ok":true,"data":{"durationMs":5,"sent":1,"failed":0}}')).toBe(
      "data:{failed,sent}"
    );
  });

  it("uses sorted top-level keys when there is no data envelope", () => {
    expect(bodySignature('{"ok":true,"claimed":0,"processed":0,"deferred":0,"stranded":0}')).toBe(
      "{claimed,deferred,ok,processed,stranded}"
    );
  });

  it("drops durationMs from the signature so timing does not split groups", () => {
    expect(bodySignature('{"durationMs":12,"sent":3}')).toBe("{sent}");
  });

  it("labels non-object JSON and unparseable bodies distinctly", () => {
    expect(bodySignature("[1,2]")).toBe("(non-object)");
    expect(bodySignature('"hi"')).toBe("(non-object)");
    expect(bodySignature("<html>gateway error</html>")).toBe("(unparseable)");
    expect(bodySignature(null)).toBe("(empty)");
    expect(bodySignature("")).toBe("(empty)");
  });

  it("treats a non-object data field as part of the top level", () => {
    expect(bodySignature('{"ok":true,"data":[1]}')).toBe("{data,ok}");
  });
});

describe("extractDurationMs", () => {
  it("reads data.durationMs first, then a root durationMs", () => {
    expect(extractDurationMs('{"data":{"durationMs":480}}')).toBe(480);
    expect(extractDurationMs('{"durationMs":142}')).toBe(142);
  });

  it("prefers the envelope when both exist", () => {
    expect(extractDurationMs('{"durationMs":1,"data":{"durationMs":2}}')).toBe(2);
  });

  it("returns null for missing, negative, non-finite, or non-numeric values", () => {
    expect(extractDurationMs('{"ok":true}')).toBeNull();
    expect(extractDurationMs('{"durationMs":"fast"}')).toBeNull();
    expect(extractDurationMs('{"durationMs":-1}')).toBeNull();
    expect(extractDurationMs('{"durationMs":null}')).toBeNull();
    expect(extractDurationMs("not json")).toBeNull();
    expect(extractDurationMs(null)).toBeNull();
  });

  it("returns null for JSON that is not an object", () => {
    expect(extractDurationMs("[1,2]")).toBeNull();
    expect(extractDurationMs('"hi"')).toBeNull();
  });
});

describe("percentile", () => {
  it("interpolates on the sorted values", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([3, 1, 2], 100)).toBe(3);
    expect(percentile([3, 1, 2], 0)).toBe(1);
  });

  it("returns null for an empty list", () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe("summarizeResponses", () => {
  it("groups by signature with status, timeout, and duration stats", () => {
    const rows = [
      row({ content: '{"data":{"sent":1,"durationMs":100}}' }),
      row({ content: '{"data":{"sent":2,"durationMs":300}}' }),
      row({ content: '{"data":{"sent":0,"durationMs":200}}', statusCode: 500 }),
      row({ content: '{"claimed":1,"ok":true}' }),
      row({ content: null, timedOut: true, statusCode: 0 })
    ];
    const report = summarizeResponses(rows);

    expect(report.total).toBe(5);
    expect(report.window).toEqual({
      oldest: new Date("2026-08-05T12:00:00Z"),
      newest: new Date("2026-08-05T12:00:00Z")
    });

    const bySig = new Map(report.groups.map((g) => [g.signature, g]));
    const sent = bySig.get("data:{sent}");
    expect(sent).toMatchObject({ n: 3, ok2xx: 2, http5xx: 1, timedOut: 0 });
    expect(sent?.durations).toMatchObject({ n: 3, maxMs: 300 });
    expect(sent?.durations.p50Ms).toBe(200);

    expect(bySig.get("{claimed,ok}")).toMatchObject({ n: 1, ok2xx: 1, durations: { n: 0 } });
    expect(bySig.get("(empty)")).toMatchObject({ n: 1, ok2xx: 0, timedOut: 1 });
  });

  it("orders groups by worst duration first so the heavies surface", () => {
    const report = summarizeResponses([
      row({ content: '{"a":1,"durationMs":10}' }),
      row({ content: '{"b":1,"durationMs":9000}' })
    ]);
    expect(report.groups[0].signature).toBe("{b}");
  });

  it("counts errored rows, 4xx responses, and spans the true window", () => {
    const report = summarizeResponses([
      row({ created: new Date("2026-08-05T10:00:00Z"), errorMsg: "boom", statusCode: 0 }),
      row({ created: new Date("2026-08-05T13:00:00Z") }),
      // A 401 is what a bad cron bearer looks like; it must not vanish into
      // the "not 2xx, not 5xx" gap.
      row({ created: new Date("2026-08-05T12:00:00Z"), statusCode: 401 })
    ]);
    expect(report.errored).toBe(1);
    expect(report.groups.reduce((sum, g) => sum + g.http4xx, 0)).toBe(1);
    expect(report.window).toEqual({
      oldest: new Date("2026-08-05T10:00:00Z"),
      newest: new Date("2026-08-05T13:00:00Z")
    });
  });

  it("handles zero rows without inventing a window", () => {
    const report = summarizeResponses([]);
    expect(report).toMatchObject({ total: 0, errored: 0, groups: [] });
    expect(report.window).toBeNull();
  });
});
