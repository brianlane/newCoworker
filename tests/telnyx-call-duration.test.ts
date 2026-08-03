import { describe, expect, it } from "vitest";
import {
  MAX_PLAUSIBLE_CALL_SECONDS,
  parseCallDurationSeconds
} from "../supabase/functions/_shared/telnyx_call_duration";

describe("parseCallDurationSeconds", () => {
  describe("explicit call_duration wins", () => {
    it("reads a numeric call_duration", () => {
      expect(parseCallDurationSeconds({ call_duration: 137 })).toBe(137);
    });

    it("reads a numeric-string call_duration", () => {
      expect(parseCallDurationSeconds({ call_duration: "137" })).toBe(137);
    });

    it("floors a fractional call_duration", () => {
      expect(parseCallDurationSeconds({ call_duration: 42.9 })).toBe(42);
    });

    it("accepts zero", () => {
      expect(parseCallDurationSeconds({ call_duration: 0 })).toBe(0);
    });

    it("takes precedence over the timestamp span", () => {
      expect(
        parseCallDurationSeconds({
          call_duration: 10,
          start_time: "2026-08-03T17:05:02.000Z",
          end_time: "2026-08-03T17:15:45.000Z"
        })
      ).toBe(10);
    });
  });

  describe("start_time / end_time fallback", () => {
    // The real payload shape from Amy's Aug 3 forwarded call, which metered
    // zero before this fallback existed: 17:05:02 -> 17:15:45 is 643s.
    it("derives the span when call_duration is absent", () => {
      expect(
        parseCallDurationSeconds({
          start_time: "2026-08-03T17:05:02.251Z",
          end_time: "2026-08-03T17:15:45.952Z"
        })
      ).toBe(643);
    });

    it("falls back when call_duration is present but unusable", () => {
      for (const bad of [null, undefined, "", "  ", "abc", Number.NaN, -5]) {
        expect(
          parseCallDurationSeconds({
            call_duration: bad,
            start_time: "2026-07-31T22:03:58.000Z",
            end_time: "2026-07-31T22:06:30.000Z"
          })
        ).toBe(152);
      }
    });

    it("floors a fractional span", () => {
      expect(
        parseCallDurationSeconds({
          start_time: "2026-08-03T17:05:02.000Z",
          end_time: "2026-08-03T17:05:04.900Z"
        })
      ).toBe(2);
    });

    it("returns 0 for a same-instant span rather than null", () => {
      expect(
        parseCallDurationSeconds({
          start_time: "2026-08-03T17:05:02.000Z",
          end_time: "2026-08-03T17:05:02.000Z"
        })
      ).toBe(0);
    });
  });

  describe("returns null when there is nothing defensible to bill", () => {
    it("empty payload", () => {
      expect(parseCallDurationSeconds({})).toBeNull();
    });

    it("start_time without end_time", () => {
      expect(
        parseCallDurationSeconds({ start_time: "2026-08-03T17:05:02.000Z" })
      ).toBeNull();
    });

    it("end_time without start_time", () => {
      expect(
        parseCallDurationSeconds({ end_time: "2026-08-03T17:15:45.000Z" })
      ).toBeNull();
    });

    it("unparseable timestamps", () => {
      expect(
        parseCallDurationSeconds({ start_time: "not-a-date", end_time: "also-not" })
      ).toBeNull();
    });

    it("non-string timestamps", () => {
      expect(
        parseCallDurationSeconds({ start_time: 1754240702000, end_time: 1754241345000 })
      ).toBeNull();
    });

    // Clock skew / swapped fields. Not clamped to 0: a wrong span is not
    // evidence of a zero-length call, and billing 0 would hide it.
    it("negative span (end before start)", () => {
      expect(
        parseCallDurationSeconds({
          start_time: "2026-08-03T17:15:45.000Z",
          end_time: "2026-08-03T17:05:02.000Z"
        })
      ).toBeNull();
    });

    it("absurd span beyond the plausibility ceiling", () => {
      expect(
        parseCallDurationSeconds({
          start_time: "1970-01-01T00:00:00.000Z",
          end_time: "2026-08-03T17:15:45.000Z"
        })
      ).toBeNull();
    });

    it("accepts a span exactly at the ceiling", () => {
      expect(
        parseCallDurationSeconds({
          start_time: "2026-08-03T00:00:00.000Z",
          end_time: "2026-08-04T00:00:00.000Z"
        })
      ).toBe(MAX_PLAUSIBLE_CALL_SECONDS);
    });

    it("rejects a span one second past the ceiling", () => {
      expect(
        parseCallDurationSeconds({
          start_time: "2026-08-03T00:00:00.000Z",
          end_time: "2026-08-04T00:00:01.000Z"
        })
      ).toBeNull();
    });
  });
});
