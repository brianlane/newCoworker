import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_TRIGGER_URL_RUN_STATUSES,
  findActiveRunWithTriggerUrl,
  triggerUrlDedupeKey
} from "../supabase/functions/_shared/ai_flows/trigger_url_dedupe";

/**
 * Same-URL enqueue guard. HomeLight's "too late" SMS still matches has_url
 * plus the earlier alert in the correlation window; without this, persisting
 * inbound jobs before eval would start a second run of the same referral.
 */

type Call = { op: string; args: unknown[] };

function mockClient(result: { data: unknown; error: unknown } | Error) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  const chain = (op: string) => {
    return (...args: unknown[]) => {
      calls.push({ op, args });
      return builder;
    };
  };
  builder.select = chain("select");
  builder.eq = chain("eq");
  builder.in = chain("in");
  builder.limit = chain("limit");
  builder.maybeSingle = async () => {
    calls.push({ op: "maybeSingle", args: [] });
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    calls,
    from: (table: string) => {
      calls.push({ op: "from", args: [table] });
      return builder;
    }
  };
}

describe("triggerUrlDedupeKey", () => {
  it("returns the trimmed url or null when empty", () => {
    expect(triggerUrlDedupeKey(" https://hmlt.co/08dba950 ")).toBe("https://hmlt.co/08dba950");
    expect(triggerUrlDedupeKey("")).toBeNull();
    expect(triggerUrlDedupeKey("   ")).toBeNull();
    expect(triggerUrlDedupeKey(null)).toBeNull();
    expect(triggerUrlDedupeKey(undefined)).toBeNull();
  });
});

describe("findActiveRunWithTriggerUrl", () => {
  it("does not query when the url is empty", async () => {
    const db = mockClient({ data: { id: "run-1" }, error: null });
    expect(
      await findActiveRunWithTriggerUrl(db, { businessId: "b", flowId: "f", url: "" })
    ).toBeNull();
    expect(db.calls).toEqual([]);
  });

  it("returns the active run when one already carries this trigger.url", async () => {
    const db = mockClient({ data: { id: "run-1" }, error: null });
    const hit = await findActiveRunWithTriggerUrl(db, {
      businessId: "biz",
      flowId: "flow",
      url: "https://hmlt.co/08dba950"
    });
    expect(hit).toEqual({ id: "run-1" });
    expect(db.calls.find((c) => c.op === "from")?.args).toEqual(["ai_flow_runs"]);
    expect(db.calls).toContainEqual({
      op: "eq",
      args: ["context->trigger->>url", "https://hmlt.co/08dba950"]
    });
    expect(db.calls).toContainEqual({
      op: "in",
      args: ["status", [...ACTIVE_TRIGGER_URL_RUN_STATUSES]]
    });
  });

  it("fails open on a lookup error so a dropped lead is never the outcome", async () => {
    const db = mockClient({ data: null, error: { message: "down" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await findActiveRunWithTriggerUrl(db, {
        businessId: "b",
        flowId: "f",
        url: "https://hmlt.co/x"
      })
    ).toBeNull();
    spy.mockRestore();
  });

  it("fails open when maybeSingle throws", async () => {
    const db = mockClient(new Error("network"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await findActiveRunWithTriggerUrl(db, {
        businessId: "b",
        flowId: "f",
        url: "https://hmlt.co/x"
      })
    ).toBeNull();
    spy.mockRestore();
  });
});
