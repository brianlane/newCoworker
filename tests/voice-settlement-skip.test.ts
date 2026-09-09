import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isNeverAnsweredReservation } from "../supabase/functions/_shared/voice_settlement";

const __dirname = dirname(fileURLToPath(import.meta.url));
const callEndSrc = readFileSync(
  join(__dirname, "../supabase/functions/telnyx-voice-call-end/index.ts"),
  "utf8"
);

describe("isNeverAnsweredReservation", () => {
  it("is false when there is no reservation row", () => {
    expect(isNeverAnsweredReservation(null)).toBe(false);
    expect(isNeverAnsweredReservation(undefined)).toBe(false);
  });

  it("is true when neither answer nor websocket ever landed", () => {
    expect(isNeverAnsweredReservation({ ws_connected_at: null, answer_issued_at: null })).toBe(
      true
    );
    expect(isNeverAnsweredReservation({})).toBe(true);
  });

  it("is false once answer was issued, even with no websocket", () => {
    expect(
      isNeverAnsweredReservation({
        ws_connected_at: null,
        answer_issued_at: "2026-09-09T20:54:04.000Z"
      })
    ).toBe(false);
  });

  it("is false once the media websocket attached", () => {
    expect(
      isNeverAnsweredReservation({
        ws_connected_at: "2026-09-09T20:54:04.000Z",
        answer_issued_at: null
      })
    ).toBe(false);
  });
});

describe("telnyx-voice-call-end skips settlement on never-answered hangup", () => {
  it("selects the connect timestamps and returns skip never_answered", () => {
    expect(callEndSrc).toContain('select("business_id, id, ws_connected_at, answer_issued_at")');
    expect(callEndSrc).toContain("isNeverAnsweredReservation");
    expect(callEndSrc).toContain('skip: "never_answered"');
    expect(callEndSrc).toContain("voice_settlement_skipped_never_answered");
  });
});
