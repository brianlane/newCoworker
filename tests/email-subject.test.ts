import { describe, expect, it } from "vitest";
import {
  MAX_SUBJECT_CHARS,
  oneLineSubject
} from "../supabase/functions/_shared/email_subject";

describe("oneLineSubject", () => {
  it("collapses newlines and whitespace runs to single spaces (Resend 422 regression)", () => {
    // The Aug 1 2026 KYP failure alert: the summary embedded a
    // pretty-printed Telnyx error body, and Resend rejected the subject
    // with `The \n is not allowed in the subject field`.
    const summary =
      'An AiFlow stopped, send_sms: telnyx 400: {\n  "errors": [\n    {\n      "code": "40310"\n    }\n  ]\n}';
    const subject = oneLineSubject(summary);
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toBe(
      'An AiFlow stopped, send_sms: telnyx 400: { "errors": [ { "code": "40310" } ] }'
    );
    expect(oneLineSubject("a\r\nb\tc")).toBe("a b c");
  });

  it("trims and caps the length", () => {
    expect(oneLineSubject("  hello  ")).toBe("hello");
    expect(oneLineSubject("x".repeat(500))).toHaveLength(MAX_SUBJECT_CHARS);
    expect(oneLineSubject("x".repeat(500), 20)).toHaveLength(20);
  });

  it("leaves a short single-line summary untouched", () => {
    expect(oneLineSubject("Missed call from a lead")).toBe("Missed call from a lead");
  });
});
