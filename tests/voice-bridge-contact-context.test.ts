import { describe, expect, it } from "vitest";
import {
  CONTACT_TIMELINE_LOOKBACK_HOURS as SHARED_LOOKBACK,
  TIMELINE_MAX_EVENTS as SHARED_MAX_EVENTS,
  TIMELINE_MAX_LINE_CHARS as SHARED_MAX_LINE,
  formatContactTimeline,
  loadContactTimeline,
  type ContactTimelineEvent
} from "../supabase/functions/_shared/contact_context";
import { inboundSmsBody } from "../supabase/functions/_shared/telnyx_sms_compliance";
import {
  CONTACT_TIMELINE_LOOKBACK_HOURS as VOICE_LOOKBACK,
  TIMELINE_MAX_EVENTS as VOICE_MAX_EVENTS,
  TIMELINE_MAX_LINE_CHARS as VOICE_MAX_LINE,
  formatVoiceContactTimeline,
  loadVoiceContactTimeline,
  voiceJobInboundText
} from "../vps/voice-bridge/src/contact-context";

/**
 * The voice bridge is rsynced to the VPS standalone, so it vendors a mirror
 * of the shared contact-timeline module instead of importing it. The DATA
 * rules (queries, lookback, caps, merge/order, envelope parsing) must stay
 * identical — only the surrounding wording is channel-specific. These tests
 * pin the two implementations against each other so a one-sided edit is
 * loud (same pattern as tests/voice-bridge-flow-run-context.test.ts).
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+15199560528";

const EVENTS: ContactTimelineEvent[] = [
  { at: "2026-07-14T17:10:22Z", channel: "sms_in", text: "July 23, 2026" },
  {
    at: "2026-07-14T17:09:03Z",
    channel: "sms_out",
    text: "What prompted you to shop around today?"
  },
  {
    at: "2026-07-14T16:00:00Z",
    channel: "voice",
    text: `(inbound call) ${"x".repeat(400)}`
  },
  { at: "", channel: "sms_in", text: "dropped (no timestamp)" },
  { at: "2026-07-14T15:00:00Z", channel: "sms_in", text: "   " }
];

describe("caps parity", () => {
  it("lookback, event cap, and line cap match the shared module", () => {
    expect(VOICE_LOOKBACK).toBe(SHARED_LOOKBACK);
    expect(VOICE_MAX_EVENTS).toBe(SHARED_MAX_EVENTS);
    expect(VOICE_MAX_LINE).toBe(SHARED_MAX_LINE);
  });
});

describe("format parity (data lines identical, wording channel-specific)", () => {
  it("event lines match the shared module line-for-line modulo the speaker label", () => {
    const shared = formatContactTimeline(EVENTS)!.split("\n").slice(1);
    const voice = formatVoiceContactTimeline(EVENTS)!.split("\n").slice(1);
    expect(voice).toEqual(shared.map((l) => l.replace("[Contact (SMS)]", "[Caller (SMS)]")));
  });

  it("both return null on the same unusable input", () => {
    const unusable: ContactTimelineEvent[] = [
      { at: "", channel: "sms_in", text: "x" },
      { at: "2026-07-14T15:00:00Z", channel: "sms_out", text: " " }
    ];
    expect(formatContactTimeline(unusable)).toBeNull();
    expect(formatVoiceContactTimeline(unusable)).toBeNull();
    expect(formatContactTimeline([])).toBeNull();
    expect(formatVoiceContactTimeline([])).toBeNull();
  });
});

describe("inbound-envelope parsing parity (vendored inboundSmsBody copy)", () => {
  it("matches telnyx_sms_compliance.inboundSmsBody on every envelope shape", () => {
    const shapes: Array<Record<string, unknown>> = [
      { text: "plain text" },
      { body: "body string" },
      { body: { text: "rcs typed" } },
      { body: { suggestion_response: { text: "rcs tapped reply" } } },
      { body: { suggestion_response: {} } },
      { body: ["not", "an", "object"] },
      {}
    ];
    for (const inner of shapes) {
      expect(voiceJobInboundText({ data: { payload: inner } })).toBe(inboundSmsBody(inner));
    }
    expect(voiceJobInboundText(null)).toBe("");
    expect(voiceJobInboundText({})).toBe("");
  });
});

describe("loader parity (same wire shape against the same fake client)", () => {
  type Scripted = { data?: unknown; error?: unknown };

  function makeDb(results: Scripted[]) {
    const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
    let idx = 0;
    const next = () => results[idx++] ?? { data: null, error: null };
    const from = (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "gte", "order", "limit"]) {
        builder[m] = (...args: unknown[]) => {
          calls.push({ table, name: m, args });
          return builder;
        };
      }
      builder["then"] = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(next()).then(resolve);
      return builder;
    };
    return {
      db: { from: (t: string) => (calls.push({ table: t, name: "from", args: [] }), from(t)) },
      calls
    };
  }

  const RESULTS: Scripted[] = [
    {
      data: [
        { created_at: "2026-07-14T17:10:22Z", payload: { data: { payload: { text: "July 23, 2026" } } } }
      ]
    },
    { data: [{ created_at: "2026-07-14T17:09:03Z", body: "When does your policy renew?" }] },
    {
      data: [
        {
          started_at: "2026-07-14T16:00:00Z",
          created_at: "2026-07-14T16:00:01Z",
          direction: "inbound",
          summary: "Asked about quotes.",
          status: "done"
        }
      ]
    }
  ];

  it("both loaders hit the same tables with the same filters and merge identically", async () => {
    const shared = makeDb(RESULTS);
    const voice = makeDb(RESULTS);
    const sharedText = await loadContactTimeline(shared.db, BIZ, LEAD);
    const voiceText = await loadVoiceContactTimeline(voice.db, BIZ, LEAD);
    expect(voiceText!.split("\n").slice(1)).toEqual(
      sharedText!
        .split("\n")
        .slice(1)
        .map((l) => l.replace("[Contact (SMS)]", "[Caller (SMS)]"))
    );
    const wire = (calls: typeof shared.calls) =>
      calls
        .filter((c) => c.name !== "from")
        .map((c) =>
          // The lookback bound is Date.now()-derived and the two loaders run
          // milliseconds apart — normalize the timestamp, compare the shape.
          `${c.table}.${c.name}(${JSON.stringify(c.args)})`.replace(
            /\d{4}-\d{2}-\d{2}T[\d:.]+Z/g,
            "<since>"
          )
        );
    expect(wire(voice.calls)).toEqual(wire(shared.calls));
  });

  it("both return null for an empty window and on a blown-up client", async () => {
    const empty1 = makeDb([{ data: [] }, { data: [] }, { data: [] }]);
    const empty2 = makeDb([{ data: [] }, { data: [] }, { data: [] }]);
    expect(await loadContactTimeline(empty1.db, BIZ, LEAD)).toBeNull();
    expect(await loadVoiceContactTimeline(empty2.db, BIZ, LEAD)).toBeNull();
    expect(await loadContactTimeline(empty1.db, BIZ, "")).toBeNull();
    expect(await loadVoiceContactTimeline(empty2.db, BIZ, "")).toBeNull();
  });
});
