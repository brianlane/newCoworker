import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TELNYX_IDEMPOTENCY_KEY_MAX,
  TELNYX_IDEMPOTENCY_KEY_PATTERN,
  toTelnyxIdempotencyKey
} from "../supabase/functions/_shared/telnyx_idempotency_key";
import {
  TELNYX_SCHEMA_ERROR_CODE,
  isPermanentTelnyxSmsFailure,
  isTelnyxIdempotencyHeaderFailure,
  isTelnyxSmsSchemaFailure,
  telnyxSmsRejectedOperatorCopy
} from "../supabase/functions/_shared/telnyx_permanent_failure";

const RUN = "550e8400-e29b-41d4-a716-446655440000";

function telnyxErrors(errors: unknown, status = 400): { status: number; body: string } {
  return { status, body: JSON.stringify({ errors }) };
}

describe("toTelnyxIdempotencyKey", () => {
  it("omits empty, null, undefined, and whitespace-only values", () => {
    expect(toTelnyxIdempotencyKey(undefined)).toBeUndefined();
    expect(toTelnyxIdempotencyKey(null)).toBeUndefined();
    expect(toTelnyxIdempotencyKey("")).toBeUndefined();
    expect(toTelnyxIdempotencyKey("   ")).toBeUndefined();
  });

  it("leaves an already-valid UUID (inbound worker style) unchanged", () => {
    const uuid = "7e85df5e-9f71-4ce9-a57a-811dd96c031a";
    expect(toTelnyxIdempotencyKey(uuid)).toBe(uuid);
    expect(TELNYX_IDEMPOTENCY_KEY_PATTERN.test(uuid)).toBe(true);
  });

  it("rewrites AiFlow colon keys so Telnyx will accept them", () => {
    const logical = `aiflow:${RUN}:3`;
    const encoded = toTelnyxIdempotencyKey(logical);
    expect(encoded).toBe(`aiflow-${RUN}-3`);
    expect(TELNYX_IDEMPOTENCY_KEY_PATTERN.test(encoded!)).toBe(true);
    expect(encoded).not.toContain(":");
  });

  it("rewrites route_to_team offer keys that include an E.164 plus sign", () => {
    const logical = `aiflow-offer:${RUN}:+16025551212`;
    const encoded = toTelnyxIdempotencyKey(logical);
    expect(encoded).toBe(`aiflow-offer-${RUN}--16025551212`);
    expect(TELNYX_IDEMPOTENCY_KEY_PATTERN.test(encoded!)).toBe(true);
  });

  it("is stable across retries of the same logical send", () => {
    const logical = `aiflow-offer-reminder-1:${RUN}:+16025551212`;
    expect(toTelnyxIdempotencyKey(logical)).toBe(toTelnyxIdempotencyKey(logical));
  });

  it("clips overlong values to Telnyx's 255-char max", () => {
    const raw = `aiflow-${"x".repeat(TELNYX_IDEMPOTENCY_KEY_MAX)}`;
    const encoded = toTelnyxIdempotencyKey(raw)!;
    expect(encoded.length).toBe(TELNYX_IDEMPOTENCY_KEY_MAX);
    expect(TELNYX_IDEMPOTENCY_KEY_PATTERN.test(encoded)).toBe(true);
  });
});

describe("Telnyx SMS 4xx classification", () => {
  const headerBody = JSON.stringify({
    errors: [
      {
        code: TELNYX_SCHEMA_ERROR_CODE,
        title: "Bad Request",
        detail: "Invalid value",
        source: { pointer: "/header/Idempotency-Key" }
      }
    ]
  });

  it("treats 4xx as permanent except timeout and rate limit", () => {
    expect(isPermanentTelnyxSmsFailure(400)).toBe(true);
    expect(isPermanentTelnyxSmsFailure(409)).toBe(true);
    expect(isPermanentTelnyxSmsFailure(422)).toBe(true);
    expect(isPermanentTelnyxSmsFailure(408)).toBe(false);
    expect(isPermanentTelnyxSmsFailure(429)).toBe(false);
    expect(isPermanentTelnyxSmsFailure(500)).toBe(false);
    expect(isPermanentTelnyxSmsFailure(200)).toBe(false);
  });

  it("recognises 10015 on /header/Idempotency-Key as a header failure, not a destination reject", () => {
    expect(isTelnyxIdempotencyHeaderFailure(400, headerBody)).toBe(true);
    expect(isTelnyxSmsSchemaFailure(400, headerBody)).toBe(true);
  });

  it("recognises the pointer in a non-JSON body", () => {
    expect(isTelnyxIdempotencyHeaderFailure(400, "pointer=/header/Idempotency-Key")).toBe(true);
  });

  it("recognises source.parameter and a 10015 detail that names idempotency", () => {
    expect(
      isTelnyxIdempotencyHeaderFailure(
        400,
        telnyxErrors([{ code: "10015", source: { parameter: "Idempotency-Key" } }]).body
      )
    ).toBe(true);
    expect(
      isTelnyxIdempotencyHeaderFailure(
        400,
        telnyxErrors([{ code: 10015, detail: "malformed idempotency value" }]).body
      )
    ).toBe(true);
  });

  it("does not treat a destination 40310 as a header/schema failure", () => {
    const body = JSON.stringify({
      errors: [{ code: "40310", title: "Invalid 'to' address" }]
    });
    expect(isTelnyxIdempotencyHeaderFailure(400, body)).toBe(false);
    expect(isTelnyxSmsSchemaFailure(400, body)).toBe(false);
  });

  it("treats a 10015 that is not about the idempotency header as schema validation", () => {
    const body = JSON.stringify({
      errors: [{ code: "10015", title: "Bad Request", source: { pointer: "/to" } }]
    });
    expect(isTelnyxIdempotencyHeaderFailure(400, body)).toBe(false);
    expect(isTelnyxSmsSchemaFailure(400, body)).toBe(true);
  });

  it("ignores 10015 on a transient status, unparseable bodies, and empty error lists", () => {
    expect(isTelnyxIdempotencyHeaderFailure(408, headerBody)).toBe(false);
    expect(isTelnyxSmsSchemaFailure(429, headerBody)).toBe(false);
    expect(isTelnyxIdempotencyHeaderFailure(400, "<html>nope</html>")).toBe(false);
    expect(isTelnyxSmsSchemaFailure(400, JSON.stringify({ errors: "nope" }))).toBe(false);
    expect(isTelnyxSmsSchemaFailure(400, JSON.stringify({ errors: [] }))).toBe(false);
    expect(isTelnyxSmsSchemaFailure(400, JSON.stringify({ errors: [null, 5, { code: "40310" }] }))).toBe(
      false
    );
    expect(isTelnyxSmsSchemaFailure(400, JSON.stringify({ errors: [{}] }))).toBe(false);
  });
});

describe("telnyxSmsRejectedOperatorCopy", () => {
  const to = "+16025551212";

  it("does not tell operators a 10015 Idempotency-Key reject means the destination is undialable", () => {
    const msg = telnyxSmsRejectedOperatorCopy({
      target: `the text to ${to}`,
      status: 400,
      body: JSON.stringify({
        errors: [
          {
            code: "10015",
            title: "Bad Request",
            source: { pointer: "/header/Idempotency-Key" }
          }
        ]
      })
    });
    expect(msg.toLowerCase()).not.toContain("isn't a real dialable line");
    expect(msg).toContain("Idempotency-Key");
    expect(msg).toContain("request-header");
    expect(msg).toContain(to);
    expect(msg).toContain("was not rejected as a phone number");
  });

  it("does not map a non-header 10015 to an undialable-line reject either", () => {
    const msg = telnyxSmsRejectedOperatorCopy({
      target: `the text to ${to}`,
      status: 400,
      body: JSON.stringify({
        errors: [{ code: "10015", title: "Bad Request", source: { pointer: "/from" } }]
      })
    });
    expect(msg.toLowerCase()).not.toContain("isn't a real dialable line");
    expect(msg).toContain("malformed request");
    expect(msg).toContain(TELNYX_SCHEMA_ERROR_CODE);
  });

  it("keeps the destination copy for a real carrier reject (40310)", () => {
    const msg = telnyxSmsRejectedOperatorCopy({
      target: `the text to ${to}`,
      status: 400,
      body: JSON.stringify({
        errors: [{ code: "40310", title: "Invalid 'to' address" }]
      })
    });
    expect(msg).toContain("isn't a real dialable line");
    expect(msg).toContain(to);
    expect(msg).not.toContain("Idempotency-Key");
  });

  it("does not label 408, 429, or 5xx as an undialable destination", () => {
    // sendOfferSms throws this helper on every failed send, so a transient
    // status must not reuse the permanent destination sentence.
    for (const status of [408, 429, 500, 503]) {
      const msg = telnyxSmsRejectedOperatorCopy({
        target: `the offer text to ${to}`,
        status,
        body: "upstream timeout"
      });
      expect(msg.toLowerCase(), `status ${status}`).not.toContain("isn't a real dialable line");
      expect(msg.toLowerCase(), `status ${status}`).not.toContain("a retry can't fix it");
      expect(msg).toContain("transient");
      expect(msg).toContain("retry may succeed");
      expect(msg).toContain(`telnyx ${status}`);
    }
  });
});

describe("AiFlow worker wires the shared copy, not an all-4xx undialable line", () => {
  const worker = readFileSync("supabase/functions/ai-flow-worker/index.ts", "utf8");

  it("routes send_sms / group / offer Telnyx 4xx through telnyxSmsRejectedOperatorCopy", () => {
    expect(worker).toContain("telnyxSmsRejectedOperatorCopy");
    expect(worker).toContain('target: `the text to ${toE164}`');
    expect(worker).toContain('target: "the group text"');
    expect(worker).toContain("target: `the offer text to ${to}`");
  });

  it("sendOfferSms still throws the shared copy on every Telnyx failure (helper now classifies transient)", () => {
    const offer = worker.slice(worker.indexOf("async function sendOfferSms"));
    const throwBlock = offer.slice(0, offer.indexOf("await logOutboundSms"));
    expect(throwBlock).toContain("if (!send.ok)");
    expect(throwBlock).toContain("telnyxSmsRejectedOperatorCopy");
    expect(throwBlock).not.toContain("isn't a real dialable line");
  });

  it("does not inline the old all-4xx undialable sentence on the Telnyx 4xx path", () => {
    // The NANP/+52 length backstops still (correctly) say "isn't a real
    // dialable line" for numbers we never send. The 4xx mapper must not.
    expect(worker).not.toMatch(
      /isPermanentTelnyxSmsFailure\(send\.status\)\) \{\s*\n\s*return \{\s*\n\s*kind: "fail",\s*\n\s*error:\s*\n\s*`send_sms: the carrier rejected the text to \$\{toE164\} and a retry can't fix it, `\s*\+\s*\n\s*`usually the number isn't a real dialable line/
    );
  });

  it("still keys send_sms on a stable per-run+step logical key (encoded at the client)", () => {
    expect(worker).toContain("idempotencyKey: `aiflow:${run.id}:${index}`");
  });
});
