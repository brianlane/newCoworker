/**
 * Tests for Slack webhook verification + envelope parsing
 * (src/lib/slack/webhook.ts).
 *
 * The signature check is the security boundary for every Slack delivery:
 * it must verify the RAW body against the v0 scheme, refuse stale
 * timestamps (replay window), and fail closed on any missing input.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseSlackEventEnvelope,
  parseSlackInteractionPayload,
  SLACK_SIGNATURE_MAX_SKEW_MS,
  tokensRevokedCoversBot,
  verifySlackSignature
} from "@/lib/slack/webhook";

const SECRET = "signing-secret-abc";

function sign(rawBody: string, timestampSec: number, secret = SECRET): string {
  return `v0=${createHmac("sha256", secret)
    .update(`v0:${timestampSec}:${rawBody}`)
    .digest("hex")}`;
}

beforeEach(() => {
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("verifySlackSignature", () => {
  const now = 1_700_000_000_000;
  const ts = Math.floor(now / 1000);
  const body = JSON.stringify({ type: "event_callback" });

  it("accepts a correctly signed, fresh delivery (env secret)", () => {
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: String(ts),
        signatureHeader: sign(body, ts),
        now
      })
    ).toBe(true);
  });

  it("accepts an explicitly passed signing secret", () => {
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: String(ts),
        signatureHeader: sign(body, ts, "other"),
        signingSecret: "other",
        now
      })
    ).toBe(true);
  });

  it("fails closed on missing secret or headers", () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "");
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: String(ts),
        signatureHeader: sign(body, ts),
        now
      })
    ).toBe(false);
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    expect(
      verifySlackSignature({ rawBody: body, timestampHeader: null, signatureHeader: "x", now })
    ).toBe(false);
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: String(ts),
        signatureHeader: null,
        now
      })
    ).toBe(false);
  });

  it("rejects a non-numeric or stale timestamp (replay window)", () => {
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: "not-a-number",
        signatureHeader: sign(body, ts),
        now
      })
    ).toBe(false);

    const staleSec = Math.floor((now - SLACK_SIGNATURE_MAX_SKEW_MS - 1000) / 1000);
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: String(staleSec),
        signatureHeader: sign(body, staleSec),
        now
      })
    ).toBe(false);
  });

  it("rejects wrong signatures of both same and different length", () => {
    const good = sign(body, ts);
    const flipped = good.endsWith("0") ? `${good.slice(0, -1)}1` : `${good.slice(0, -1)}0`;
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: String(ts),
        signatureHeader: flipped,
        now
      })
    ).toBe(false);
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: String(ts),
        signatureHeader: "v0=short",
        now
      })
    ).toBe(false);
    // Signed over a DIFFERENT body: authentic-looking but not this delivery.
    expect(
      verifySlackSignature({
        rawBody: body,
        timestampHeader: String(ts),
        signatureHeader: sign("other-body", ts),
        now
      })
    ).toBe(false);
  });
});

describe("parseSlackEventEnvelope", () => {
  it("parses url_verification with its challenge", () => {
    expect(parseSlackEventEnvelope({ type: "url_verification", challenge: "abc" })).toEqual({
      kind: "url_verification",
      challenge: "abc"
    });
    expect(parseSlackEventEnvelope({ type: "url_verification" })).toBeNull();
    expect(parseSlackEventEnvelope({ type: "url_verification", challenge: "" })).toBeNull();
  });

  it("parses event_callback with team, event id and inner event", () => {
    expect(
      parseSlackEventEnvelope({
        type: "event_callback",
        team_id: "T-1",
        event_id: "Ev-1",
        event: { type: "app_uninstalled" }
      })
    ).toEqual({
      kind: "event_callback",
      teamId: "T-1",
      eventId: "Ev-1",
      event: { type: "app_uninstalled" }
    });
  });

  it("nulls the event id when absent and refuses malformed callbacks", () => {
    expect(
      parseSlackEventEnvelope({
        type: "event_callback",
        team_id: "T-1",
        event: { type: "message" }
      })
    ).toMatchObject({ eventId: null });

    expect(parseSlackEventEnvelope({ type: "event_callback", event: { type: "x" } })).toBeNull();
    expect(parseSlackEventEnvelope({ type: "event_callback", team_id: "" , event: { type: "x" } })).toBeNull();
    expect(parseSlackEventEnvelope({ type: "event_callback", team_id: "T-1" })).toBeNull();
    expect(
      parseSlackEventEnvelope({ type: "event_callback", team_id: "T-1", event: "nope" })
    ).toBeNull();
    expect(
      parseSlackEventEnvelope({ type: "event_callback", team_id: "T-1", event: {} })
    ).toBeNull();
    expect(
      parseSlackEventEnvelope({ type: "event_callback", team_id: "T-1", event: { type: "" } })
    ).toBeNull();
  });

  it("refuses non-envelopes", () => {
    expect(parseSlackEventEnvelope(null)).toBeNull();
    expect(parseSlackEventEnvelope("str")).toBeNull();
    expect(parseSlackEventEnvelope({ type: "something_else" })).toBeNull();
  });
});

describe("tokensRevokedCoversBot", () => {
  it("is true only for a non-empty tokens.bot list", () => {
    expect(
      tokensRevokedCoversBot({ type: "tokens_revoked", tokens: { bot: ["B-1"] } })
    ).toBe(true);
    expect(
      tokensRevokedCoversBot({ type: "tokens_revoked", tokens: { oauth: ["U-1"], bot: [] } })
    ).toBe(false);
    expect(tokensRevokedCoversBot({ type: "tokens_revoked", tokens: {} })).toBe(false);
    expect(tokensRevokedCoversBot({ type: "tokens_revoked" })).toBe(false);
    expect(
      tokensRevokedCoversBot({ type: "tokens_revoked", tokens: "junk" } as never)
    ).toBe(false);
    expect(
      tokensRevokedCoversBot({ type: "tokens_revoked", tokens: { bot: "junk" } } as never)
    ).toBe(false);
    expect(tokensRevokedCoversBot({ type: "app_uninstalled" })).toBe(false);
  });
});

describe("parseSlackInteractionPayload", () => {
  const wrap = (payload: unknown) => `payload=${encodeURIComponent(JSON.stringify(payload))}`;

  it("parses a block_actions press", () => {
    const parsed = parseSlackInteractionPayload(
      wrap({
        type: "block_actions",
        team: { id: "T-1" },
        user: { id: "U-1", name: "amy" },
        actions: [{ action_id: "aiflow_approval:approve", value: "{}" }],
        response_url: "https://hooks/r"
      })
    );
    expect(parsed).toEqual({
      teamId: "T-1",
      userId: "U-1",
      userName: "amy",
      actionId: "aiflow_approval:approve",
      value: "{}",
      responseUrl: "https://hooks/r"
    });
  });

  it("falls back to username, nulls missing extras, refuses junk", () => {
    const parsed = parseSlackInteractionPayload(
      wrap({
        type: "block_actions",
        team: { id: "T-1" },
        user: { id: "U-1", username: "amy2" },
        actions: [{ action_id: "a" }]
      })
    );
    expect(parsed).toMatchObject({ userName: "amy2", value: "", responseUrl: null });

    const emptyName = parseSlackInteractionPayload(
      wrap({
        type: "block_actions",
        team: { id: "T-1" },
        user: { id: "U-1", name: "" },
        actions: [{ action_id: "a" }]
      })
    );
    expect(emptyName).toMatchObject({ userName: null });

    expect(parseSlackInteractionPayload("payload=not-json")).toBeNull();
    expect(parseSlackInteractionPayload("nothing=here")).toBeNull();
    expect(parseSlackInteractionPayload(wrap({ type: "view_submission" }))).toBeNull();
    expect(
      parseSlackInteractionPayload(wrap({ type: "block_actions", team: {}, user: { id: "U" } }))
    ).toBeNull();
    expect(
      parseSlackInteractionPayload(
        wrap({ type: "block_actions", team: { id: "T" }, user: { id: "U" }, actions: [] })
      )
    ).toBeNull();
  });
});
