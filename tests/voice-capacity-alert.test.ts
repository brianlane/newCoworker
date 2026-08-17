import { describe, expect, it, vi } from "vitest";
import {
  CAPACITY_ALERT_BUCKET_MINUTES,
  formatCapacityAlertEmail,
  sendVoiceCapacityAlertOnce,
  type CapacityAlertInfo,
  type CapacityAlertSupabase
} from "../supabase/functions/_shared/voice_capacity_alert";

const INFO: CapacityAlertInfo = {
  businessId: "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3",
  flowId: "ffb54048-f8b8-4eb9-b260-325171eff5f6",
  toE164: "+16029200022",
  httpStatus: 403,
  telnyxCode: "90010",
  telnyxTitle: "Channel limit exceeded",
  connectionId: "2937312861107521228"
};

function stubSupabase(
  claim: { data: unknown; error: { message: string } | null } | "throw"
): {
  supabase: CapacityAlertSupabase;
  rpc: ReturnType<typeof vi.fn>;
  deletedIds: unknown[];
} {
  const deletedIds: unknown[] = [];
  const rpc = vi.fn(async () => {
    if (claim === "throw") throw new Error("network down");
    return claim;
  });
  const supabase: CapacityAlertSupabase = {
    rpc: rpc as unknown as CapacityAlertSupabase["rpc"],
    from: (table: string) => {
      expect(table).toBe("voice_capacity_alerts");
      return {
        delete: () => ({
          eq: async (column: string, value: unknown) => {
            expect(column).toBe("id");
            deletedIds.push(value);
            return { error: null };
          }
        })
      };
    }
  };
  return { supabase, rpc, deletedIds };
}

const fullEnv = (name: string): string | undefined =>
  ({
    RESEND_API_KEY: "re_test",
    ADMIN_ALERT_EMAIL: "alerts@newcoworker.com",
    MAILER_EMAIL: "New Coworker <contact@newcoworker.com>"
  })[name];

const okFetch = () =>
  vi.fn(async () => ({ ok: true, status: 200, text: async () => "" })) as unknown as typeof fetch;

describe("formatCapacityAlertEmail", () => {
  it("names the rejection facts and says the call is retried, not lost", () => {
    const email = formatCapacityAlertEmail(INFO);
    expect(email.subject).toContain("channel limit");
    expect(email.text).toContain(INFO.businessId);
    expect(email.text).toContain("+16029200022");
    expect(email.text).toContain("90010");
    expect(email.text).toContain("defers and retries");
    expect(email.text).toContain("once per hour");
  });

  it("prints placeholders for unparsed fields", () => {
    const email = formatCapacityAlertEmail({
      ...INFO,
      flowId: null,
      telnyxCode: null,
      telnyxTitle: null,
      connectionId: null
    });
    expect(email.text).toContain("flow_id: (none)");
    expect(email.text).toContain("telnyx_code: (unparsed)");
    expect(email.text).toContain("connection_id: (unknown)");
  });
});

describe("sendVoiceCapacityAlertOnce", () => {
  it("claims the fleet bucket then emails the admin", async () => {
    const { supabase, rpc, deletedIds } = stubSupabase({ data: 7, error: null });
    const fetchFn = okFetch();

    const result = await sendVoiceCapacityAlertOnce(supabase, INFO, fullEnv, fetchFn);

    expect(result).toBe("sent");
    expect(rpc).toHaveBeenCalledWith("voice_capacity_try_claim_alert", {
      p_business_id: INFO.businessId,
      p_flow_id: INFO.flowId,
      p_telnyx_code: INFO.telnyxCode,
      p_http_status: INFO.httpStatus,
      p_bucket_minutes: CAPACITY_ALERT_BUCKET_MINUTES,
      p_kind: "carrier_rejection"
    });
    expect(deletedIds).toEqual([]);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string }
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_test");
    const body = JSON.parse(init.body) as { to: string[]; subject: string; text: string };
    expect(body.to).toEqual(["alerts@newcoworker.com"]);
    expect(body.subject).toContain("Telnyx capacity");
  });

  it("skips quietly when another invocation already holds the bucket", async () => {
    const { supabase } = stubSupabase({ data: null, error: null });
    const fetchFn = okFetch();
    const result = await sendVoiceCapacityAlertOnce(supabase, INFO, fullEnv, fetchFn);
    expect(result).toBe("already_alerted");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns claim_failed on an RPC error and never emails", async () => {
    const { supabase } = stubSupabase({ data: null, error: { message: "boom" } });
    const fetchFn = okFetch();
    expect(await sendVoiceCapacityAlertOnce(supabase, INFO, fullEnv, fetchFn)).toBe("claim_failed");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns claim_failed when the RPC throws (never propagates)", async () => {
    const { supabase } = stubSupabase("throw");
    expect(await sendVoiceCapacityAlertOnce(supabase, INFO, fullEnv, okFetch())).toBe(
      "claim_failed"
    );
  });

  it("releases the claim when unconfigured so the next rejection retries", async () => {
    const { supabase, deletedIds } = stubSupabase({ data: 11, error: null });
    // No fetchFn argument on purpose: the default (global fetch) must be
    // usable, and this path returns before any network happens.
    const result = await sendVoiceCapacityAlertOnce(supabase, INFO, () => undefined);
    expect(result).toBe("unconfigured");
    expect(deletedIds).toEqual([11]);
  });

  it("falls back ADMIN_ALERT_EMAIL -> ADMIN_EMAIL -> CONTACT_EMAIL", async () => {
    const { supabase } = stubSupabase({ data: 3, error: null });
    const fetchFn = okFetch();
    const env = (name: string): string | undefined =>
      ({ RESEND_API_KEY: "re_test", CONTACT_EMAIL: "team@newcoworker.com" })[name];
    expect(await sendVoiceCapacityAlertOnce(supabase, INFO, env, fetchFn)).toBe("sent");
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { body: string }
    ];
    expect((JSON.parse(init.body) as { to: string[] }).to).toEqual(["team@newcoworker.com"]);
  });

  it("releases the claim on a Resend non-2xx (even when the body read rejects)", async () => {
    const { supabase, deletedIds } = stubSupabase({ data: 5, error: null });
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("body stream interrupted");
      }
    })) as unknown as typeof fetch;
    expect(await sendVoiceCapacityAlertOnce(supabase, INFO, fullEnv, fetchFn)).toBe("post_failed");
    expect(deletedIds).toEqual([5]);
  });

  it("releases the claim when the send throws", async () => {
    const { supabase, deletedIds } = stubSupabase({ data: 9, error: null });
    const fetchFn = vi.fn(async () => {
      throw new Error("socket hangup");
    }) as unknown as typeof fetch;
    expect(await sendVoiceCapacityAlertOnce(supabase, INFO, fullEnv, fetchFn)).toBe("post_failed");
    expect(deletedIds).toEqual([9]);
  });

  // The release itself failing must not throw out of the alert path (the
  // dial branch that invokes it is production call handling): the stuck row
  // just mutes alerts until the bucket rolls, which the next bucket heals.
  it("swallows a release DB error", async () => {
    const supabase: CapacityAlertSupabase = {
      rpc: (async () => ({ data: 13, error: null })) as CapacityAlertSupabase["rpc"],
      from: () => ({
        delete: () => ({ eq: async () => ({ error: { message: "locked" } }) })
      })
    };
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "down"
    })) as unknown as typeof fetch;
    expect(await sendVoiceCapacityAlertOnce(supabase, INFO, fullEnv, fetchFn)).toBe("post_failed");
  });

  it("swallows a release that throws", async () => {
    const supabase: CapacityAlertSupabase = {
      rpc: (async () => ({ data: 17, error: null })) as CapacityAlertSupabase["rpc"],
      from: () => ({
        delete: () => ({
          eq: async () => {
            throw new Error("connection reset");
          }
        })
      })
    };
    expect(await sendVoiceCapacityAlertOnce(supabase, INFO, () => undefined, okFetch())).toBe(
      "unconfigured"
    );
  });
});

/**
 * The weekly capacity monitor rides the same claim/release dedupe with its
 * own kind, week-long bucket, and email body; the defaults above must stay
 * byte-identical for the inline carrier-rejection path.
 */
describe("sendVoiceCapacityAlertOnce: monitor overrides", () => {
  it("claims with the override kind and bucket, and sends the override email", async () => {
    const { supabase, rpc } = stubSupabase({ data: 21, error: null });
    const fetchFn = okFetch();
    const result = await sendVoiceCapacityAlertOnce(
      supabase,
      { ...INFO, businessId: null },
      fullEnv,
      fetchFn,
      {
        kind: "capacity_monitor",
        bucketMinutes: 10080,
        email: { subject: "weekly review", text: "the fleet is tight" }
      }
    );
    expect(result).toBe("sent");
    expect(rpc).toHaveBeenCalledWith("voice_capacity_try_claim_alert", {
      p_business_id: null,
      p_flow_id: INFO.flowId,
      p_telnyx_code: INFO.telnyxCode,
      p_http_status: INFO.httpStatus,
      p_bucket_minutes: 10080,
      p_kind: "capacity_monitor"
    });
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { body: string }
    ];
    const body = JSON.parse(init.body) as { subject: string; text: string };
    expect(body.subject).toBe("weekly review");
    expect(body.text).toBe("the fleet is tight");
  });

  it("prints (fleet) for a null business id in the default email", () => {
    const email = formatCapacityAlertEmail({ ...INFO, businessId: null });
    expect(email.text).toContain("business_id: (fleet)");
  });
});
