import { describe, expect, it } from "vitest";

import {
  LIVENESS_CHANNELS,
  judgeAudience,
  judgeChannel,
  livenessFinding,
  usableSignal,
  type ChannelEvidence,
  type ChannelJudgement,
  type LivenessChannel
} from "@/lib/notifications/channel-liveness";

/**
 * The policy constants are module-private on purpose, so these assert the
 * BEHAVIOUR the numbers produce rather than re-stating the numbers. A test
 * that imports a constant and compares it to itself proves nothing; a test
 * that says "nine alerts is not enough to judge, ten is" would fail if the
 * floor moved without anyone thinking about it.
 */
const MIN_SENDS = 10;

const NOW = Date.parse("2026-08-28T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function evidence(over: Partial<ChannelEvidence> & { channel: LivenessChannel }): ChannelEvidence {
  return {
    sends: MIN_SENDS,
    lastHumanSignalAt: null,
    attributed: true,
    receipted: 0,
    hardFailures: 0,
    ...over
  };
}

function judged(over: Partial<ChannelJudgement> & { channel: LivenessChannel }): ChannelJudgement {
  return {
    verdict: "live",
    sends: 20,
    silentDays: 1,
    attributed: true,
    detail: "detail",
    ...over
  };
}

describe("usableSignal", () => {
  it("passes a real timestamp through unchanged", () => {
    const iso = daysAgo(3);
    expect(usableSignal(iso)).toBe(iso);
  });

  it("treats absent, empty and unparseable stamps as no evidence", () => {
    expect(usableSignal(null)).toBeNull();
    expect(usableSignal(undefined)).toBeNull();
    expect(usableSignal("")).toBeNull();
    expect(usableSignal("not a date")).toBeNull();
  });

  it("treats the epoch sentinel as no evidence, not 56 years of silence", () => {
    // messenger_conversations stores this literal value for a thread that
    // exists but has never carried an inbound message, which is the exact
    // state of KYP Ads' owner WhatsApp thread.
    expect(usableSignal("1970-01-01T00:00:00+00:00")).toBeNull();
  });
});

describe("judgeChannel: the low-volume gate", () => {
  it("refuses to judge a channel under the send floor", () => {
    const j = judgeChannel(evidence({ channel: "sms", sends: MIN_SENDS - 1 }), NOW);
    expect(j.verdict).toBe("unused");
    expect(j.silentDays).toBeNull();
    expect(j.detail).toContain("under the");
  });

  it("applies the floor to email too, before any receipt arithmetic", () => {
    const j = judgeChannel(
      evidence({ channel: "email", sends: 3, receipted: 3, hardFailures: 3 }),
      NOW
    );
    expect(j.verdict).toBe("unused");
  });
});

describe("judgeChannel: reply-based channels", () => {
  it("is live when a human acted inside the threshold", () => {
    const j = judgeChannel(
      evidence({ channel: "sms", sends: 77, lastHumanSignalAt: daysAgo(2) }),
      NOW
    );
    expect(j.verdict).toBe("live");
    expect(j.silentDays).toBeCloseTo(2, 5);
    expect(j.detail).toBe("last human signal 2.0d ago");
  });

  it("is silent past the threshold: the KYP Ads case", () => {
    // 77 SMS alerts in 30 days, last owner reply 35 days ago, every send
    // carrier-stamped delivered to a number with no active SIM.
    const j = judgeChannel(
      evidence({ channel: "sms", sends: 77, lastHumanSignalAt: daysAgo(35.1) }),
      NOW
    );
    expect(j.verdict).toBe("silent");
    expect(j.detail).toContain("last human signal 35.1d ago");
    expect(j.detail).toContain("limit 21d");
  });

  it("is silent when a busy channel has never had a human signal", () => {
    const j = judgeChannel(evidence({ channel: "whatsapp", sends: 16 }), NOW);
    expect(j.verdict).toBe("silent");
    expect(j.silentDays).toBeNull();
    expect(j.detail).toContain("no human signal EVER");
  });

  it("holds the boundary: exactly at the limit is still live", () => {
    const j = judgeChannel(
      evidence({ channel: "dashboard", sends: 60, lastHumanSignalAt: daysAgo(21) }),
      NOW
    );
    expect(j.verdict).toBe("live");
  });

  it("gives Slack a looser limit than the conversational channels", () => {
    // New Coworker's owner, the only healthy Slack tenant on the fleet, last
    // posted 17.5 days ago. A 21-day limit would leave the one known-good
    // example three days from tripping.
    const at = daysAgo(25);
    expect(judgeChannel(evidence({ channel: "slack", sends: 14, lastHumanSignalAt: at }), NOW).verdict).toBe(
      "live"
    );
    expect(judgeChannel(evidence({ channel: "sms", sends: 14, lastHumanSignalAt: at }), NOW).verdict).toBe(
      "silent"
    );
  });

  it("carries the attribution flag through untouched", () => {
    const j = judgeChannel(
      evidence({ channel: "dashboard", sends: 60, lastHumanSignalAt: daysAgo(1), attributed: false }),
      NOW
    );
    expect(j.verdict).toBe("live");
    expect(j.attributed).toBe(false);
  });
});

describe("judgeChannel: email is judged on bounces, never on replies", () => {
  it("is undecidable when no send carries a receipt yet", () => {
    // recordNotificationEmail only started writing email_log rows for alerts
    // on 2026-08-26, so most of any 30-day window predates the receipts.
    const j = judgeChannel(evidence({ channel: "email", sends: 136, receipted: 0 }), NOW);
    expect(j.verdict).toBe("undecidable");
    expect(j.detail).toContain("none carrying a delivery receipt");
  });

  it("is live when at least one receipted send landed", () => {
    const j = judgeChannel(
      evidence({ channel: "email", sends: 136, receipted: 4, hardFailures: 1 }),
      NOW
    );
    expect(j.verdict).toBe("live");
    expect(j.detail).toBe("3 of 4 receipted send(s) delivered");
  });

  it("is silent only when every receipted send hard-failed", () => {
    const j = judgeChannel(
      evidence({ channel: "email", sends: 40, receipted: 5, hardFailures: 5 }),
      NOW
    );
    expect(j.verdict).toBe("silent");
    expect(j.detail).toContain("all 5 receipted send(s) of 40 bounced");
  });

  it("never consults lastHumanSignalAt: owners do not reply to alert mail", () => {
    // The naive prototype flagged email as dead on nine of eleven tenants
    // for exactly this reason. A never-replied email channel with clean
    // receipts must come out live.
    const j = judgeChannel(
      evidence({ channel: "email", sends: 86, lastHumanSignalAt: null, receipted: 2 }),
      NOW
    );
    expect(j.verdict).toBe("live");
  });
});

describe("every channel has a stated silence policy", () => {
  it("judges every channel in the dispatch fan-out, with no silent gaps", () => {
    // A channel missing from the policy record would read as `undefined`,
    // which is not `null`, so it would fall down the reply path and compare
    // against undefined: every comparison false, and a decade-old signal
    // would come back "live". Asserting the OUTCOME catches that; asserting
    // that the record has five keys does not.
    for (const channel of LIVENESS_CHANNELS) {
      const j = judgeChannel(
        evidence({ channel, sends: 50, lastHumanSignalAt: daysAgo(3650) }),
        NOW
      );
      expect(j.verdict, `${channel} has no silence policy`).not.toBe("live");
    }
  });

  it("holds the floor at exactly ten alerts in the window", () => {
    const below = judgeChannel(evidence({ channel: "sms", sends: 9 }), NOW);
    const at = judgeChannel(evidence({ channel: "sms", sends: 10 }), NOW);
    expect(below.verdict).toBe("unused");
    expect(at.verdict).toBe("silent");
  });
});

describe("judgeAudience", () => {
  it("is live when nothing is silent", () => {
    const a = judgeAudience([
      judged({ channel: "sms" }),
      judged({ channel: "email", verdict: "undecidable" }),
      judged({ channel: "slack", verdict: "unused" })
    ]);
    expect(a.state).toBe("live");
    expect(a.silent).toEqual([]);
  });

  it("is degraded when a silent channel sits beside a live one", () => {
    const a = judgeAudience([
      judged({ channel: "sms", verdict: "silent" }),
      judged({ channel: "whatsapp", verdict: "silent" }),
      judged({ channel: "email" }),
      judged({ channel: "dashboard" })
    ]);
    expect(a.state).toBe("degraded");
    expect(a.silent).toEqual(["sms", "whatsapp"]);
    expect(a.live).toEqual(["email", "dashboard"]);
  });

  it("is dark only when a channel is silent and none is live", () => {
    const a = judgeAudience([
      judged({ channel: "sms", verdict: "silent" }),
      judged({ channel: "email", verdict: "undecidable" }),
      judged({ channel: "slack", verdict: "unused" })
    ]);
    expect(a.state).toBe("dark");
  });

  it("does not let an undecidable channel rescue a dark tenant", () => {
    const a = judgeAudience([
      judged({ channel: "sms", verdict: "silent" }),
      judged({ channel: "email", verdict: "undecidable" })
    ]);
    expect(a.state).toBe("dark");
    expect(a.live).toEqual([]);
  });

  it("does not let an unused channel make a healthy tenant look broken", () => {
    const a = judgeAudience([
      judged({ channel: "email", verdict: "unused" }),
      judged({ channel: "sms", verdict: "unused" })
    ]);
    expect(a.state).toBe("live");
  });
});

describe("livenessFinding", () => {
  it("says nothing about a healthy tenant", () => {
    expect(livenessFinding("Fine Co", judgeAudience([judged({ channel: "sms" })]))).toBeNull();
  });

  it("raises degraded as a warn that names the channel still working", () => {
    const finding = livenessFinding(
      "KYP Ads",
      judgeAudience([
        judged({ channel: "sms", verdict: "silent", detail: "last human signal 35.1d ago" }),
        judged({ channel: "whatsapp", verdict: "silent", detail: "no human signal EVER" }),
        judged({ channel: "email" }),
        judged({ channel: "dashboard" })
      ])
    );
    expect(finding?.level).toBe("warn");
    expect(finding?.event).toBe("alert_audience_degraded");
    expect(finding?.message).toContain("sms (last human signal 35.1d ago)");
    expect(finding?.message).toContain("Still reaching them: email, dashboard");
    // Never "this customer is unreachable": on the tenant that motivated
    // this feature, that claim would have been false.
    expect(finding?.message).not.toContain("No alert channel");
    expect(finding?.payload.silentChannels).toEqual(["sms", "whatsapp"]);
  });

  it("raises dark as an error that tells someone to call", () => {
    const finding = livenessFinding(
      "Dark Co",
      judgeAudience([judged({ channel: "sms", verdict: "silent", detail: "no human signal EVER" })])
    );
    expect(finding?.level).toBe("error");
    expect(finding?.event).toBe("alert_audience_dark");
    expect(finding?.message).toContain("call them");
  });

  it("rounds silentDays in the payload and preserves null", () => {
    const finding = livenessFinding(
      "Rounding Co",
      judgeAudience([
        judged({ channel: "sms", verdict: "silent", silentDays: 35.1234, detail: "d" }),
        judged({ channel: "email", silentDays: null })
      ])
    );
    const channels = finding?.payload.channels as { channel: string; silentDays: number | null }[];
    expect(channels.find((c) => c.channel === "sms")?.silentDays).toBe(35.1);
    expect(channels.find((c) => c.channel === "email")?.silentDays).toBeNull();
  });

  it("degrades gracefully when a silent channel has no matching judgement", () => {
    // Hand-built shape rather than one judgeAudience produced, so the
    // formatter cannot crash on a caller that assembles the two halves.
    const finding = livenessFinding("Odd Co", {
      state: "dark",
      channels: [],
      silent: ["sms"],
      live: []
    });
    expect(finding?.message).toContain("sms (no detail)");
  });
});
