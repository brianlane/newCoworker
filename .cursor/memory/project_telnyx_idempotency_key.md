---
name: telnyx-idempotency-key-charset
description: Telnyx Idempotency-Key allows only [A-Za-z0-9_-]{1,255}; colons 400 with code 10015, not an undialable destination
metadata:
  type: project
---

# Telnyx Idempotency-Key charset (2026-09-15)

Telnyx OpenAPI `IdempotencyKey` and the live Messaging API: the header is
optional, **1 to 255 letters, numbers, hyphens, or underscores**. Empty,
duplicated, malformed, or overlong values return **HTTP 400 / code 10015**
with pointer `/header/Idempotency-Key`.

AiFlow `send_sms` / `route_to_team` built logical keys with **colons**
(`aiflow:${runId}:${step}`, `aiflow-offer:${runId}:${e164}`). The E.164
`+` in offer keys is also illegal. Inbound replies that mint
`crypto.randomUUID()` stay valid, which is why 2026-09-15 was not a total
SMS outage: inbound was clean and some `sms_outbound_log` rows still got
Telnyx message ids.

`toTelnyxIdempotencyKey` in
`supabase/functions/_shared/telnyx_idempotency_key.ts` rewrites at the
HTTP seam (`telnyxSendSms`, `telnyxSendGroupMms`, Node `sendTelnyxSms`).
The mapping is deterministic so retries of the same logical send reuse the
same encoded header.

**Do not map 10015 / header validation to "isn't a real dialable line".**
That copy lives in `telnyxSmsRejectedOperatorCopy`. 10015 is request
schema validation. Destination rejects are 40310 and friends. The Sep 15
incident made PO/ops retire good NANP leads because `send_sms` stamped
every permanent 4xx with the undialable sentence.
