/**
 * Contract tests for the Telnyx-SMS-inbound Edge function's outbound-DLR
 * observability path.
 *
 * Why a source-string test rather than an end-to-end integration test:
 * the Edge function imports a Deno-only `serve` from
 * https://deno.land/std/http/server.ts plus several other Deno-specific
 * URLs that won't load under Vitest's Node ESM resolver. An integration
 * test would either need a Deno test runner (different stack) or a heavy
 * fake-import shim. The substantive risk we want to lock down is small:
 *   1. message.finalized / message.sent get a dedicated branch (so they
 *      aren't lumped into the "skip" path silently).
 *   2. We surface delivery_failed / sending_failed (and similar non-OK
 *      statuses) to telemetry so 10DLC / carrier-block regressions are
 *      visible without combing through Telnyx Mission Control.
 *   3. We don't fail the webhook on outbound DLRs (Telnyx must always see
 *      a 200 — failed retries cause more cascading webhook spam).
 *
 * Source-string assertions are good enough for that contract and have
 * zero infra cost. If the file's structure changes substantially, this
 * test breaks loudly and forces a revisit.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const source = readFileSync(
  join(repoRoot, "supabase/functions/telnyx-sms-inbound/index.ts"),
  "utf8"
);

describe("telnyx-sms-inbound: outbound DLR telemetry", () => {
  it("branches on message.finalized / message.sent before the message.received gate", () => {
    expect(source).toMatch(
      /eventType === "message\.finalized" \|\| eventType === "message\.sent"/
    );
    // The DLR branch must come BEFORE the legacy `eventType !== "message.received"`
    // skip — otherwise the finalized/sent events fall straight into "skipped"
    // without any telemetry being emitted.
    const idxDlr = source.indexOf(
      'eventType === "message.finalized" || eventType === "message.sent"'
    );
    const idxSkipReceived = source.indexOf(
      'if (eventType !== "message.received")'
    );
    expect(idxDlr).toBeGreaterThan(0);
    expect(idxSkipReceived).toBeGreaterThan(idxDlr);
  });

  it("only emits telemetry for non-OK recipient statuses (skips delivered/queued/sent/sending)", () => {
    // Pin the exact whitelist so an over-eager refactor that emits telemetry
    // for `delivered` or `queued` doesn't silently spam the table.
    expect(source).toMatch(
      /status !== "delivered" && status !== "queued" && status !== "sent" && status !== "sending"/
    );
  });

  it("records the canonical fields needed to debug 10DLC / carrier rejections", () => {
    const expected = [
      "telnyx_sms_outbound_dlr",
      "outbound_message_id",
      "recipient_e164",
      "recipient_status",
      "recipient_carrier",
      "errors"
    ];
    for (const field of expected) {
      expect(source).toContain(field);
    }
  });

  it("always returns 200 for outbound DLRs (no retry storms)", () => {
    // Inside the message.finalized/message.sent branch, the response must be
    // a 200 with `{ ok: true, skipped: eventType }`. Telnyx retries on 5xx,
    // and a webhook handler that 5xx-s on every DLR would cause a flood of
    // duplicate telemetry rows.
    expect(source).toMatch(
      /eventType === "message\.finalized" \|\| eventType === "message\.sent"[\s\S]*?status: 200,[\s\S]*?ok: true, skipped: eventType/
    );
  });

  it("does not throw on missing payload.to (defensive parsing)", () => {
    // Verifies the `Array.isArray(payload.to)` guard is in place. Telnyx is
    // documented to always include `to[]` but defensive parsing prevents the
    // Edge function from panicking if a future Telnyx revision drops it.
    expect(source).toMatch(/Array\.isArray\(payload\.to\)/);
  });
});
