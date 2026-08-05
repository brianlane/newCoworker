import { describe, expect, it } from "vitest";
import {
  VOICE_SESSION_MAX_AGE_MS,
  classifyVoiceSession,
  partitionVoiceSessions
} from "../src/lib/telnyx/active-session.ts";

const NOW = new Date("2026-08-04T18:00:00.000Z");
const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();

describe("classifyVoiceSession", () => {
  it("treats a stamped ended_at as ended regardless of how fresh the heartbeat is", () => {
    expect(
      classifyVoiceSession(
        { call_control_id: "a", ended_at: iso(1000), last_seen_at: iso(500) },
        NOW
      )
    ).toBe("ended");
  });

  it("treats a recently heartbeating unended session as live", () => {
    expect(
      classifyVoiceSession(
        { call_control_id: "a", ended_at: null, last_seen_at: iso(15_000) },
        NOW
      )
    ).toBe("live");
  });

  it("treats an unended session past the ceiling as stale, not live", () => {
    expect(
      classifyVoiceSession(
        {
          call_control_id: "a",
          ended_at: null,
          last_seen_at: iso(VOICE_SESSION_MAX_AGE_MS + 1)
        },
        NOW
      )
    ).toBe("stale");
  });

  it("holds a session exactly at the ceiling as stale (boundary is exclusive)", () => {
    expect(
      classifyVoiceSession(
        { call_control_id: "a", ended_at: null, last_seen_at: iso(VOICE_SESSION_MAX_AGE_MS) },
        NOW
      )
    ).toBe("stale");
  });

  it("falls back to media_started_at when the first heartbeat never landed", () => {
    expect(
      classifyVoiceSession(
        { call_control_id: "a", ended_at: null, last_seen_at: null, media_started_at: iso(2000) },
        NOW
      )
    ).toBe("live");
    expect(
      classifyVoiceSession(
        {
          call_control_id: "a",
          ended_at: null,
          media_started_at: iso(VOICE_SESSION_MAX_AGE_MS + 1)
        },
        NOW
      )
    ).toBe("stale");
  });

  it("uses the LATER of the two stamps so a stale media_started_at cannot age out a live call", () => {
    expect(
      classifyVoiceSession(
        {
          call_control_id: "a",
          ended_at: null,
          last_seen_at: iso(5_000),
          media_started_at: iso(VOICE_SESSION_MAX_AGE_MS + 60_000)
        },
        NOW
      )
    ).toBe("live");
  });

  it("ignores an unparseable stamp in favour of the one that parses", () => {
    expect(
      classifyVoiceSession(
        { call_control_id: "a", ended_at: null, last_seen_at: "not-a-date", media_started_at: iso(1000) },
        NOW
      )
    ).toBe("live");
  });

  it("treats a row with no usable timestamp as live, never as safe-to-drop", () => {
    expect(
      classifyVoiceSession({ call_control_id: "a", ended_at: null }, NOW)
    ).toBe("live");
    expect(
      classifyVoiceSession(
        { call_control_id: "a", ended_at: null, last_seen_at: "garbage", media_started_at: "garbage" },
        NOW
      )
    ).toBe("live");
  });

  it("honours a caller-supplied ceiling", () => {
    const row = { call_control_id: "a", ended_at: null, last_seen_at: iso(60_000) };
    expect(classifyVoiceSession(row, NOW, 30_000)).toBe("stale");
    expect(classifyVoiceSession(row, NOW, 120_000)).toBe("live");
  });

  it("defaults now to the current clock", () => {
    expect(
      classifyVoiceSession({
        call_control_id: "a",
        ended_at: null,
        last_seen_at: new Date().toISOString()
      })
    ).toBe("live");
  });
});

describe("partitionVoiceSessions", () => {
  it("separates live from stale and drops ended rows entirely", () => {
    const { live, stale } = partitionVoiceSessions(
      [
        { call_control_id: "live-1", ended_at: null, last_seen_at: iso(10_000) },
        { call_control_id: "ended-1", ended_at: iso(500), last_seen_at: iso(900) },
        {
          call_control_id: "stale-1",
          ended_at: null,
          last_seen_at: iso(VOICE_SESSION_MAX_AGE_MS + 1)
        }
      ],
      NOW
    );
    expect(live.map((r) => r.call_control_id)).toEqual(["live-1"]);
    expect(stale.map((r) => r.call_control_id)).toEqual(["stale-1"]);
  });

  it("returns empty buckets for no rows", () => {
    expect(partitionVoiceSessions([], NOW)).toEqual({ live: [], stale: [] });
  });

  it("honours a caller-supplied ceiling", () => {
    const rows = [{ call_control_id: "a", ended_at: null, last_seen_at: iso(60_000) }];
    expect(partitionVoiceSessions(rows, NOW, 30_000).stale).toHaveLength(1);
    expect(partitionVoiceSessions(rows, NOW, 120_000).live).toHaveLength(1);
  });

  it("defaults now to the current clock", () => {
    const rows = [
      { call_control_id: "a", ended_at: null, last_seen_at: new Date().toISOString() }
    ];
    expect(partitionVoiceSessions(rows).live).toHaveLength(1);
  });
});
