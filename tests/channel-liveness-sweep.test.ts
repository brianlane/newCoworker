import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("@/lib/db/contact-names", () => ({
  businessOwnerNumbers: vi.fn().mockResolvedValue([])
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { recordSystemLog } from "@/lib/db/system-logs";
import { businessOwnerNumbers } from "@/lib/db/contact-names";
import { reportChannelLiveness } from "@/lib/notifications/channel-liveness-read";
import { sweepChannelLiveness } from "@/lib/notifications/channel-liveness-sweep";
import { LIVENESS_CHANNELS } from "@/lib/notifications/channel-liveness";
import type { ChannelJudgement, LivenessChannel } from "@/lib/notifications/channel-liveness";

/**
 * Everything here drives the two real entry points: `reportChannelLiveness`
 * (read-only) and `sweepChannelLiveness` (the same loop plus the admin
 * writes). The per-channel readers behind them are deliberately
 * module-private, because an export whose only caller is a test is dead code
 * wearing coverage. Going through the production path also proves the
 * composition, which reader feeds which channel and which filters actually
 * reach PostgREST, rather than just the pieces.
 *
 * Assertions are on the JUDGEMENT, not on raw evidence: that is what an
 * operator reads and what the alarm writes.
 */

const NOW = Date.parse("2026-08-28T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const RECEIPTS_LIVE_AT = "2026-08-26T05:37:47Z";
const READ_FAILED = "read-blew-up";

type Filter = [string, string, unknown];
type Query = { table: string; select: string; head: boolean; filters: Filter[] };
type Fixture = { data?: unknown; error?: { message: string }; count?: number };

/**
 * Minimal PostgREST-shaped double.
 *
 * `resolve` sees the whole query (table, selected columns, every filter), so
 * a test can answer the two DIFFERENT `notifications` reads differently, and
 * can assert on the filters the production code actually sent rather than on
 * a hand-fed return value.
 */
function makeDb(resolve: (q: Query) => Fixture) {
  const seen: Query[] = [];
  const db = {
    seen,
    from(table: string) {
      const q: Query = { table, select: "", head: false, filters: [] };
      seen.push(q);
      const settle = () => {
        const f = resolve(q);
        return Promise.resolve({
          data: f.data ?? null,
          error: f.error ?? null,
          count: f.count ?? null
        });
      };
      const builder: Record<string, unknown> = {
        select(cols: string, opts?: { head?: boolean }) {
          q.select = cols;
          q.head = opts?.head === true;
          return builder;
        },
        maybeSingle: settle,
        then: (ok: unknown, err: unknown) => settle().then(ok as never, err as never)
      };
      for (const verb of ["eq", "neq", "in", "gte", "not", "order", "limit"]) {
        builder[verb] = (col: string, val: unknown) => {
          q.filters.push([verb, col, val]);
          return builder;
        };
      }
      // .filter(col, op, val) carries its operator in the middle argument;
      // recorded as `filter:<op>` so an assertion can name the exact SQL
      // operator, which for the read-actor filter is the entire point.
      builder.filter = (col: string, op: string, val: unknown) => {
        q.filters.push([`filter:${op}`, col, val]);
        return builder;
      };
      return builder;
    }
  };
  return db as typeof db & NonNullable<Parameters<typeof reportChannelLiveness>[0]>["client"];
}

/** Named legs of one tenant's reads, so a test states only what it cares about. */
type Legs = {
  business?: Fixture;
  prefs?: Fixture;
  roster?: Fixture;
  sends?: Partial<Record<LivenessChannel, number>> | "missing";
  read?: Fixture;
  sms?: Fixture;
  /** notification_link_clicks with channel='sms' (the SMS deep link). */
  clicks?: Fixture;
  /** notification_link_clicks with channel='push' (a notificationclick). */
  pushClicks?: Fixture;
  whatsapp?: Fixture;
  slack?: Fixture;
  telegram?: Fixture;
  teams?: Fixture;
  email?: Fixture;
};

/**
 * Well over the ten-alert floor on every channel, so a test about a SIGNAL
 * gets a real verdict instead of `unused`.
 */
const BUSY: Record<LivenessChannel, number> = {
  sms: 40,
  email: 40,
  dashboard: 40,
  whatsapp: 40,
  slack: 40,
  telegram: 40,
  teams: 40,
  push: 40
};

function answer(q: Query, legs: Legs): Fixture {
  if (q.table === "businesses") return legs.business ?? { data: { owner_email: "o@x.com" } };
  if (q.table === "notification_preferences") return legs.prefs ?? { data: null };
  if (q.table === "ai_flow_team_members") return legs.roster ?? { data: [] };
  if (q.table === "notifications" && q.head) {
    if (legs.sends === "missing") return {};
    const channel = q.filters.find((f) => f[1] === "delivery_channel")?.[2] as LivenessChannel;
    return { count: (legs.sends ?? BUSY)[channel] ?? 0 };
  }
  if (q.table === "notifications") return legs.read ?? { data: [] };
  if (q.table === "sms_inbound_jobs") return legs.sms ?? { data: [] };
  if (q.table === "notification_link_clicks") {
    // Routed by the channel filter, so a test can give SMS and push
    // DIFFERENT signals. Serving one fixture to both would let a test pass
    // while the read silently ignored its channel filter.
    const channel = q.filters.find((f) => f[1] === "channel")?.[2];
    return (channel === "push" ? legs.pushClicks : legs.clicks) ?? { data: [] };
  }
  if (q.table === "messenger_conversations") return legs.whatsapp ?? { data: [] };
  if (q.table === "coworker_conversations") {
    // One table, every team-chat channel: the fixture is picked by the
    // channel filter the production code sent, which is also what proves
    // the filter is there at all.
    const channel = q.filters.find((f) => f[1] === "channel")?.[2];
    const perChannel: Record<string, Fixture | undefined> = {
      slack: legs.slack,
      telegram: legs.telegram,
      teams: legs.teams
    };
    return perChannel[String(channel)] ?? { data: [] };
  }
  return legs.email ?? { data: [] };
}

const ONE_TENANT = [{ id: "biz", name: "Test Co", data_residency_mode: "supabase" }];

function fleetDb(fleet: unknown[], perTenant: (q: Query) => Fixture) {
  return makeDb((q) =>
    q.table === "businesses" && q.select.includes("data_residency_mode")
      ? { data: fleet }
      : perTenant(q)
  );
}

/** One tenant through the real loop, with its queries and verdicts to hand. */
async function judgeOne(legs: Legs = {}, opts: { fail?: (q: Query) => boolean } = {}) {
  const db = fleetDb(ONE_TENANT, (q) =>
    opts.fail?.(q) ? { error: { message: READ_FAILED } } : answer(q, legs)
  );
  const [row] = await reportChannelLiveness({ now: NOW, client: db });
  const channels = row.outcome === "judged" ? row.judgement.channels : [];
  return {
    row,
    channels,
    by: (channel: LivenessChannel) =>
      channels.find((c) => c.channel === channel) as ChannelJudgement,
    db,
    query: (table: string, pick: (q: Query) => boolean = () => true) =>
      db.seen.find((q) => q.table === table && pick(q))
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(businessOwnerNumbers).mockResolvedValue([]);
});

describe("the alert audience", () => {
  it("unions owner numbers, the owner/alert emails, and the ACTIVE roster", async () => {
    vi.mocked(businessOwnerNumbers).mockResolvedValue(["+15145188192"]);
    const { query } = await judgeOne({
      business: { data: { owner_email: "James@KypAds.com" } },
      prefs: { data: { alert_email: "james@kypads.com" } },
      roster: { data: [{ phone_e164: " +16045550101 ", email: "Teammate@Example.com" }] }
    });
    expect(query("sms_inbound_jobs")?.filters).toContainEqual([
      "in",
      "customer_e164",
      ["+15145188192", "+16045550101"]
    ]);
    // Lowercased and de-duplicated: owner_email and alert_email are the same
    // mailbox in different case on the tenant that motivated this.
    expect(query("email_log")?.filters).toContainEqual([
      "in",
      "to_email",
      ["james@kypads.com", "teammate@example.com"]
    ]);
    expect(query("ai_flow_team_members")?.filters).toContainEqual(["eq", "active", true]);
  });

  it("issues no reply query at all when there is nobody to match", async () => {
    const { query } = await judgeOne({ business: { data: null }, roster: { data: null } });
    expect(query("sms_inbound_jobs")).toBeUndefined();
    expect(query("messenger_conversations")).toBeUndefined();
    expect(query("email_log")).toBeUndefined();
  });

  it("ignores blank roster fields without inventing an audience", async () => {
    const { query } = await judgeOne({
      business: { data: null },
      roster: { data: [{ phone_e164: "  ", email: " " }, {}] }
    });
    expect(query("sms_inbound_jobs")).toBeUndefined();
    expect(query("email_log")).toBeUndefined();
  });
});

describe("send counts", () => {
  it("counts each channel with a head count, never a row fetch", async () => {
    const { by, db } = await judgeOne({ sends: { sms: 77, email: 136 } });
    expect(by("sms").sends).toBe(77);
    expect(by("email").sends).toBe(136);
    expect(by("slack").sends).toBe(0);
    // head:true is what keeps the 1000-row PostgREST cap from turning a busy
    // month into a quiet-looking one.
    const counts = db.seen.filter((q) => q.table === "notifications" && q.head);
    // One head count per delivery channel, derived rather than hardcoded so
    // adding a channel cannot leave this silently under-counting.
    expect(counts).toHaveLength(LIVENESS_CHANNELS.length);
    expect(counts[0].filters).toContainEqual(["eq", "status", "sent"]);
  });

  it("treats a missing count as zero, not as unknown", async () => {
    const { channels } = await judgeOne({ sends: "missing" });
    expect(channels.every((c) => c.sends === 0)).toBe(true);
  });

  it("reports a failed count read against the channel that failed", async () => {
    const { row } = await judgeOne({}, { fail: (q) => q.table === "notifications" && q.head });
    expect(row.outcome).toBe("failed");
    expect(row.outcome === "failed" && row.error).toMatch(
      new RegExp(`countSendsByChannel\\(\\w+\\): ${READ_FAILED}`)
    );
  });
});

describe("the SMS signal", () => {
  beforeEach(() => vi.mocked(businessOwnerNumbers).mockResolvedValue(["+15145188192"]));

  it("only accepts owner/team inbound, never a customer text", async () => {
    const { by, query } = await judgeOne({ sms: { data: [{ created_at: daysAgo(35.1) }] } });
    expect(by("sms").silentDays).toBeCloseTo(35.1, 4);
    expect(query("sms_inbound_jobs")?.filters).toContainEqual([
      "in",
      "staff_kind",
      ["owner", "team"]
    ]);
  });

  it("takes the NEWER of a staff reply and an owner link tap", async () => {
    // They are different acts (answering us versus opening what we sent) and
    // either one proves a human was there, so ignoring the newer of the two
    // could only ever manufacture silence.
    const { by } = await judgeOne({
      sms: { data: [{ created_at: daysAgo(30) }] },
      clicks: { data: [{ clicked_at: daysAgo(2) }] }
    });
    expect(by("sms").verdict).toBe("live");
    expect(by("sms").silentDays).toBeCloseTo(2, 4);
  });

  it("falls back to whichever of the two exists", async () => {
    const reply = await judgeOne({ sms: { data: [{ created_at: daysAgo(4) }] } });
    expect(reply.by("sms").silentDays).toBeCloseTo(4, 4);
    const tap = await judgeOne({ clicks: { data: [{ clicked_at: daysAgo(5) }] } });
    expect(tap.by("sms").silentDays).toBeCloseTo(5, 4);
    const neither = await judgeOne();
    expect(neither.by("sms")).toMatchObject({ verdict: "silent", silentDays: null });
  });

  /**
   * A push tap is the only TRUE read receipt in this system: it fires on the
   * owner's device, from a real gesture, on a subscription bound to an
   * authenticated user. Every other channel here infers engagement.
   */
  it("reads the push tap from its own channel, excluding prefetch", async () => {
    const { query } = await judgeOne();
    const pushQuery = query("notification_link_clicks", (q) =>
      q.filters.some((f) => f[1] === "channel" && f[2] === "push")
    );
    expect(pushQuery, "no push-scoped click read was issued").toBeTruthy();
    expect(pushQuery?.filters).toContainEqual(["eq", "likely_prefetch", false]);
  });

  /**
   * The two clicks live in ONE table separated only by `channel`, so a read
   * that dropped its filter would let a push tap certify SMS as alive (and
   * the reverse). That is the same shape as the WhatsApp bug this module was
   * built after: reading the newest row of a shared table and attributing it
   * to the wrong party.
   */
  it("does not let a push tap vouch for SMS, or an SMS click for push", async () => {
    const pushOnly = await judgeOne({
      clicks: { data: [] },
      pushClicks: { data: [{ clicked_at: daysAgo(1) }] }
    });
    expect(pushOnly.by("push").verdict).toBe("live");
    expect(pushOnly.by("sms").verdict).toBe("silent");

    const smsOnly = await judgeOne({
      clicks: { data: [{ clicked_at: daysAgo(1) }] },
      pushClicks: { data: [] }
    });
    expect(smsOnly.by("sms").verdict).toBe("live");
    expect(smsOnly.by("push").verdict).toBe("silent");
  });

  it("excludes prefetch clicks and pins the channel", async () => {
    // Preview cards and carrier scanners fetch every link seconds after
    // delivery. Counting those would manufacture a perfect, permanent
    // liveness signal for a channel nobody reads.
    const { query } = await judgeOne();
    expect(query("notification_link_clicks")?.filters).toContainEqual([
      "eq",
      "likely_prefetch",
      false
    ]);
    expect(query("notification_link_clicks")?.filters).toContainEqual(["eq", "channel", "sms"]);
  });

  it("reports a failure on either SMS leg", async () => {
    const reply = await judgeOne({}, { fail: (q) => q.table === "sms_inbound_jobs" });
    expect(reply.row.outcome === "failed" && reply.row.error).toBe(`lastStaffSmsAt: ${READ_FAILED}`);
    const tap = await judgeOne({}, { fail: (q) => q.table === "notification_link_clicks" });
    expect(tap.row.outcome === "failed" && tap.row.error).toBe(
      `lastNotificationLinkClickAt(sms): ${READ_FAILED}`
    );
  });

  it("tolerates a null result set on either SMS leg", async () => {
    const { by } = await judgeOne({ sms: { data: null }, clicks: { data: null } });
    expect(by("sms")).toMatchObject({ verdict: "silent", silentDays: null });
  });
});

describe("the WhatsApp signal", () => {
  beforeEach(() => vi.mocked(businessOwnerNumbers).mockResolvedValue(["+15145188192"]));

  it("reads the OWNER's thread, not the newest lead's", async () => {
    // KYP Ads exactly: four lead threads, the newest of them hours old, and
    // the owner's own thread never carrying an inbound message. An
    // unfiltered read declares WhatsApp live on the one tenant whose
    // WhatsApp has been dead on Meta billing error 131042 for weeks.
    const { by } = await judgeOne({
      whatsapp: {
        data: [
          { psid: "16045610030", last_user_message_at: daysAgo(0.3) },
          { psid: "85295521451", last_user_message_at: daysAgo(0.1) },
          { psid: "15145188192", last_user_message_at: "1970-01-01T00:00:00+00:00" }
        ]
      }
    });
    expect(by("whatsapp").verdict).toBe("silent");
    // Attributed: we DID find the owner's thread, it is simply empty. That
    // is a different claim from "we could not tell whose thread this is".
    expect(by("whatsapp").attributed).toBe(true);
  });

  it("matches on contact_phone when the row carries one", async () => {
    const { by } = await judgeOne({
      whatsapp: {
        data: [{ psid: "opaque", contact_phone: "+15145188192", last_user_message_at: daysAgo(2) }]
      }
    });
    expect(by("whatsapp")).toMatchObject({ verdict: "live", attributed: true });
  });

  it("keeps the newest audience thread whichever order the rows arrive in", async () => {
    // The query has no ORDER BY, so a later, older row must not overwrite it.
    const ascending = await judgeOne({
      whatsapp: {
        data: [
          { psid: "15145188192", last_user_message_at: daysAgo(29) },
          { psid: "15145188192", last_user_message_at: daysAgo(1) },
          { psid: "15145188192", last_user_message_at: null }
        ]
      }
    });
    expect(ascending.by("whatsapp").silentDays).toBeCloseTo(1, 4);

    const descending = await judgeOne({
      whatsapp: {
        data: [
          { psid: "15145188192", last_user_message_at: daysAgo(1) },
          { psid: "15145188192", last_user_message_at: daysAgo(29) }
        ]
      }
    });
    expect(descending.by("whatsapp").silentDays).toBeCloseTo(1, 4);
  });

  it("reports unattributed when no thread belongs to the audience", async () => {
    const { by } = await judgeOne({
      whatsapp: { data: [{ psid: "999", last_user_message_at: daysAgo(1) }] }
    });
    expect(by("whatsapp")).toMatchObject({ verdict: "silent", attributed: false });
  });

  it("tolerates a null result set and reports an error", async () => {
    const nulls = await judgeOne({ whatsapp: { data: null } });
    expect(nulls.by("whatsapp").attributed).toBe(false);
    const failed = await judgeOne({}, { fail: (q) => q.table === "messenger_conversations" });
    expect(failed.row.outcome === "failed" && failed.row.error).toBe(`lastOwnerWhatsappAt: ${READ_FAILED}`);
  });
});

describe("the Telegram signal", () => {
  it("matches an audience member by their VERIFIED PHONE, not an email", async () => {
    // Telegram enrolment records the number Telegram verified rather than
    // an address, so the phone cross-check is the only thing that can
    // recognise a teammate on this channel.
    vi.mocked(businessOwnerNumbers).mockResolvedValue(["+15555550100"]);
    const { by } = await judgeOne({
      slack: { data: [] },
      telegram: {
        data: [
          { is_owner: false, user_phone_e164: "+15555550100", last_user_message_at: daysAgo(2) }
        ]
      }
    });
    expect(by("telegram")).toMatchObject({ verdict: "live" });
  });

  it("ignores a Telegram thread belonging to nobody in the audience", async () => {
    const { by } = await judgeOne({
      telegram: {
        data: [
          { is_owner: false, user_phone_e164: "+19998887777", last_user_message_at: daysAgo(2) }
        ]
      }
    });
    expect(by("telegram")).toMatchObject({ verdict: "silent" });
  });
});

describe("the Slack signal", () => {
  const withOwnerEmail: Legs = { business: { data: { owner_email: "owner@example.com" } } };

  it("reads only the SLACK rows out of the shared coworker pipeline", async () => {
    // coworker_conversations holds every team-chat channel now. Without the
    // channel filter, a live Telegram or Teams thread would certify Slack
    // as healthy, which is the same class of bug as reading the newest
    // WhatsApp thread instead of the owner's own.
    const { query } = await judgeOne({
      ...withOwnerEmail,
      slack: { data: [{ is_owner: true, last_user_message_at: daysAgo(3) }] }
    });
    expect(query("coworker_conversations")?.filters).toContainEqual([
      "eq",
      "channel",
      "slack"
    ]);
  });

  it("accepts the is_owner flag the Slack pipeline already stamps", async () => {
    const { by } = await judgeOne({
      ...withOwnerEmail,
      slack: { data: [{ is_owner: true, last_user_message_at: daysAgo(17.5) }] }
    });
    expect(by("slack")).toMatchObject({ verdict: "live" });
    expect(by("slack").silentDays).toBeCloseTo(17.5, 4);
  });

  it("also accepts a roster member matched by email, case-insensitively", async () => {
    const { by } = await judgeOne({
      ...withOwnerEmail,
      slack: {
        data: [
          { is_owner: false, user_email: "Owner@Example.com", last_user_message_at: daysAgo(3) }
        ]
      }
    });
    expect(by("slack").silentDays).toBeCloseTo(3, 4);
  });

  it("ignores a workspace member who is neither", async () => {
    const { by } = await judgeOne({
      ...withOwnerEmail,
      slack: {
        data: [
          { is_owner: false, user_email: "stranger@example.com", last_user_message_at: daysAgo(1) },
          { is_owner: false, last_user_message_at: daysAgo(1) }
        ]
      }
    });
    expect(by("slack")).toMatchObject({ verdict: "silent", silentDays: null });
  });

  it("treats an owner thread with no message stamp as no signal", async () => {
    const { by } = await judgeOne({ ...withOwnerEmail, slack: { data: [{ is_owner: true }] } });
    expect(by("slack")).toMatchObject({ verdict: "silent", silentDays: null });
  });

  it("tolerates a null result set and reports an error", async () => {
    const nulls = await judgeOne({ slack: { data: null } });
    expect(nulls.by("slack").silentDays).toBeNull();
    // The error names the CHANNEL, not just the reader: both Slack and
    // Telegram read this table, and "which one blew up" is the first thing
    // anyone reading the failure needs to know.
    const failed = await judgeOne({}, { fail: (q) => q.table === "coworker_conversations" });
    expect(failed.row.outcome === "failed" && failed.row.error).toBe(
      `lastAudienceMessageAt(slack): ${READ_FAILED}`
    );
  });
});

describe("the dashboard signal", () => {
  it("excludes admin reads at the query, so view-as cannot vouch for the owner", async () => {
    const { by, query } = await judgeOne({
      read: { data: [{ read_at: daysAgo(3.9), read_by_actor: "owner" }] }
    });
    expect(by("dashboard")).toMatchObject({ verdict: "live", attributed: true });
    expect(by("dashboard").silentDays).toBeCloseTo(3.9, 4);
    const q = query("notifications", (x) => !x.head);
    expect(q?.filters).toContainEqual(["not", "read_at", "is"]);
    // NULL-SAFE, and asserted on the OPERATOR rather than on returned rows,
    // because this double cannot evaluate SQL: it hands back whatever the
    // fixture says regardless of the filters, so a row-level assertion here
    // passes identically with `neq` and with `isdistinct`. That gap is how
    // the bug this guards against reached review. In Postgres
    // `read_by_actor <> 'admin'` is NULL, not TRUE, for a NULL actor, so
    // `neq` silently drops every legacy row: today that is every row on the
    // fleet, and KYP Ads would flip from degraded to dark on deploy.
    expect(q?.filters).toContainEqual(["filter:isdistinct", "read_by_actor", "admin"]);
    expect(q?.filters.some((f) => f[0] === "neq" && f[1] === "read_by_actor")).toBe(false);
  });

  it("keeps a legacy unattributed read as evidence, but marks it soft", async () => {
    const { by } = await judgeOne({
      read: { data: [{ read_at: daysAgo(3.9), read_by_actor: null }] }
    });
    expect(by("dashboard")).toMatchObject({ verdict: "live", attributed: false });
  });

  it("is silent when the dashboard has never been opened", async () => {
    const { by } = await judgeOne();
    expect(by("dashboard")).toMatchObject({ verdict: "silent", attributed: false });
  });

  it("reports a read error", async () => {
    const { row } = await judgeOne({}, { fail: (q) => q.table === "notifications" && !q.head });
    expect(row.outcome === "failed" && row.error).toBe(`lastDashboardReadAt: ${READ_FAILED}`);
  });
});

describe("the email receipts", () => {
  it("counts only receipted sends, and splits the hard failures out", async () => {
    const { by } = await judgeOne({
      email: {
        data: [
          { delivery_status: "delivered" },
          { delivery_status: "bounced" },
          { delivery_status: null },
          {}
        ]
      }
    });
    expect(by("email").verdict).toBe("live");
    expect(by("email").detail).toBe("1 of 2 receipted send(s) delivered");
  });

  it("is undecidable, never silent, when no receipt has arrived", async () => {
    // Email is not reply-judged: owners do not answer alert mail, and a
    // prototype that assumed they did flagged nine of eleven tenants dead.
    const { by } = await judgeOne();
    expect(by("email").verdict).toBe("undecidable");
  });

  it("never looks earlier than the deploy that started writing receipts", async () => {
    // A send from before that instant has no email_log row at all, so
    // counting it as unreceipted would be arithmetic that misleads.
    const { query } = await judgeOne();
    expect(query("email_log")?.filters).toContainEqual(["gte", "created_at", RECEIPTS_LIVE_AT]);
  });

  it("uses the window start once the window is newer than that deploy", async () => {
    const db = fleetDb(ONE_TENANT, (q) => answer(q, {}));
    await reportChannelLiveness({ now: Date.parse("2026-11-01T00:00:00Z"), client: db });
    const gte = db.seen
      .find((q) => q.table === "email_log")
      ?.filters.find((f) => f[1] === "created_at");
    expect(String(gte?.[2]) > RECEIPTS_LIVE_AT).toBe(true);
  });

  it("tolerates a null result set and reports an error", async () => {
    const nulls = await judgeOne({ email: { data: null } });
    expect(nulls.by("email").verdict).toBe("undecidable");
    const failed = await judgeOne({}, { fail: (q) => q.table === "email_log" });
    expect(failed.row.outcome === "failed" && failed.row.error).toBe(`emailReceiptTally: ${READ_FAILED}`);
  });
});

describe("reportChannelLiveness", () => {
  it("judges every dispatch channel, in a stable order, and writes nothing", async () => {
    const { channels } = await judgeOne();
    expect(channels.map((c) => c.channel)).toEqual([
      "sms",
      "email",
      "dashboard",
      "whatsapp",
      "slack",
      "telegram",
      "teams",
      "push"
    ]);
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("only looks at online tenants", async () => {
    const db = fleetDb([], (q) => answer(q, {}));
    await reportChannelLiveness({ now: NOW, client: db });
    expect(db.seen[0].filters).toContainEqual(["eq", "status", "online"]);
  });

  it("narrows to one tenant when asked", async () => {
    const db = fleetDb([], (q) => answer(q, {}));
    await reportChannelLiveness({ now: NOW, client: db, businessId: "just-this-one" });
    expect(db.seen[0].filters).toContainEqual(["eq", "id", "just-this-one"]);
  });

  it("skips a vps tenant instead of misreading it, and says so", async () => {
    const db = fleetDb([{ id: "v", name: "Residency Co", data_residency_mode: "vps" }], (q) =>
      answer(q, {})
    );
    const [row] = await reportChannelLiveness({ now: NOW, client: db });
    expect(row.outcome).toBe("skipped");
    expect(row.outcome === "skipped" && row.reason).toContain("purged centrally");
    // No read of the purged tables was attempted for it at all.
    expect(db.seen.filter((q) => q.table === "notifications")).toHaveLength(0);
  });

  it("judges a tenant with no residency mode recorded", async () => {
    const db = fleetDb([{ id: "b", name: "Plain Co", data_residency_mode: null }], (q) =>
      answer(q, {})
    );
    const [row] = await reportChannelLiveness({ now: NOW, client: db });
    expect(row.outcome).toBe("judged");
  });

  it("throws when the fleet list itself cannot be read", async () => {
    const db = makeDb(() => ({ error: { message: "no businesses" } }));
    await expect(reportChannelLiveness({ now: NOW, client: db })).rejects.toThrow(
      "reportChannelLiveness: no businesses"
    );
  });

  it("tolerates an empty fleet list", async () => {
    expect(await reportChannelLiveness({ now: NOW, client: makeDb(() => ({ data: null })) })).toEqual(
      []
    );
  });

  it("defaults to the service client and the current clock", async () => {
    const db = fleetDb([], (q) => answer(q, {}));
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await reportChannelLiveness()).toEqual([]);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("sweepChannelLiveness", () => {
  it("reproduces the KYP Ads verdict end to end", async () => {
    vi.mocked(businessOwnerNumbers).mockResolvedValue(["+15145188192"]);
    const db = fleetDb([{ id: "kyp", name: "KYP Ads", data_residency_mode: "supabase" }], (q) =>
      answer(q, {
        business: { data: { owner_email: "james@kypads.com" } },
        prefs: { data: { alert_email: "james@kypads.com" } },
        sends: { sms: 77, email: 136, dashboard: 109, whatsapp: 16 },
        // Dashboard: read 3.9 days ago, and now provably the owner.
        read: { data: [{ read_at: daysAgo(3.9), read_by_actor: "owner" }] },
        // SMS: last owner reply 35 days ago, ~200 sends since, all delivered.
        sms: { data: [{ created_at: daysAgo(35.1) }] },
        // WhatsApp: a lead messaged hours ago; the OWNER's thread never has.
        whatsapp: {
          data: [
            { psid: "85295521451", last_user_message_at: daysAgo(0.3) },
            { psid: "15145188192", last_user_message_at: "1970-01-01T00:00:00+00:00" }
          ]
        },
        email: { data: [{ delivery_status: "delivered" }, { delivery_status: "delivered" }] }
      })
    );

    const result = await sweepChannelLiveness({ now: NOW, client: db });
    expect(result).toMatchObject({ checked: 1, degraded: 1, dark: 0 });
    const call = vi.mocked(recordSystemLog).mock.calls[0][0];
    // Degraded, not dark: SMS and WhatsApp are gone, email and the dashboard
    // still reach him. "This customer is unreachable" would be false.
    expect(call.level).toBe("warn");
    expect(call.event).toBe("alert_audience_degraded");
    expect(call.payload?.silentChannels).toEqual(["sms", "whatsapp"]);
    expect(call.payload?.liveChannels).toEqual(["email", "dashboard"]);
  });

  it("writes nothing for a healthy fleet", async () => {
    const db = fleetDb(ONE_TENANT, (q) =>
      answer(q, {
        sends: { dashboard: 40 },
        read: { data: [{ read_at: daysAgo(1), read_by_actor: "owner" }] }
      })
    );
    const result = await sweepChannelLiveness({ now: NOW, client: db });
    expect(result).toMatchObject({ checked: 1, healthy: 1, dark: 0, degraded: 0 });
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("raises an error row for a tenant nothing reaches", async () => {
    const db = fleetDb([{ id: "dark", name: "Dark Co", data_residency_mode: "supabase" }], (q) =>
      answer(q, { email: { data: [{ delivery_status: "bounced" }] } })
    );
    const result = await sweepChannelLiveness({ now: NOW, client: db });
    expect(result).toMatchObject({ dark: 1, degraded: 0 });
    const call = vi.mocked(recordSystemLog).mock.calls[0][0];
    expect(call.level).toBe("error");
    // Admin-only: system_logs under source "notifications", which the tenant
    // dashboard's source:"aiflow" filter never returns.
    expect(call.source).toBe("notifications");
    expect(call.message).toContain("call them");
  });

  it("carries the residency skip through to the result", async () => {
    const db = fleetDb([{ id: "v", name: "Residency Co", data_residency_mode: "vps" }], (q) =>
      answer(q, {})
    );
    const result = await sweepChannelLiveness({ now: NOW, client: db });
    expect(result.checked).toBe(0);
    expect(result.skipped).toEqual([{ businessId: "v", reason: expect.stringContaining("vps") }]);
  });

  it("records a failing tenant and keeps sweeping the rest", async () => {
    const db = fleetDb(
      [
        { id: "bad", name: "Bad Co", data_residency_mode: "supabase" },
        { id: "good", name: "Good Co", data_residency_mode: "supabase" }
      ],
      (q) =>
        q.table === "notifications" && q.head && q.filters.some((f) => f[2] === "bad")
          ? { error: { message: "tenant read exploded" } }
          : answer(q, {
              sends: { dashboard: 40 },
              read: { data: [{ read_at: daysAgo(1), read_by_actor: "owner" }] }
            })
    );
    const result = await sweepChannelLiveness({ now: NOW, client: db });
    expect(result).toMatchObject({ checked: 1, healthy: 1 });
    expect(result.errors[0]).toContain("tenant read exploded");
  });

  it("records a tenant that threw something that is not an Error", async () => {
    vi.mocked(businessOwnerNumbers).mockRejectedValue("owner numbers exploded");
    const db = fleetDb(ONE_TENANT, (q) => answer(q, {}));
    const result = await sweepChannelLiveness({ now: NOW, client: db });
    expect(result.checked).toBe(0);
    expect(result.errors).toEqual(["biz: owner numbers exploded"]);
  });

  it("defaults to the service client and the current clock", async () => {
    const db = fleetDb([], (q) => answer(q, {}));
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect((await sweepChannelLiveness()).checked).toBe(0);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});
