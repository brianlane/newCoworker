/**
 * Turning a failed workspace provider call into the fields an operator needs.
 *
 * Every Gmail / Calendar / Microsoft Graph call goes through `./proxy.ts`, and
 * a rejection from it arrives in one of three shapes: an axios error from the
 * Nango branch, a `DirectTransportError` from the first-party branch (built to
 * be duck-compatible with axios, see `./direct-transport.ts`), or a
 * `DirectTransportUnreachable` that carries no HTTP response at all. All three
 * end up in some caller's catch block as a bare `unknown`, and what gets
 * written to `system_logs` there decides whether the row is diagnosable later.
 *
 * Two live incidents shaped what this keeps:
 *
 * - 2026-08-08: an email-coworker poll row read "Request failed with status
 *   code 400" with an empty payload, which says a call failed somewhere and
 *   nothing more. Gmail puts the actual reason in the response BODY ("Invalid
 *   query", an expired token), not in the status, so the body is kept too.
 * - 2026-08-22: an AiFlow email-trigger poll row read "Provider request timed
 *   out" with only a connection id. That message comes from a transport
 *   failure with no response, so status and body are both absent and the
 *   payload was `{}`: telling a 20-second abort from a DNS failure meant
 *   reading the transport source. Hence `code`, the one field those carry.
 *
 * Best effort by construction: an unrecognised throw yields `{}` rather than
 * inventing fields, and nothing here can throw on the way to a catch block.
 */

/** Transport-level failure codes, the only signal a response-less error has. */
const TRANSPORT_CODES = ["upstream_timeout", "upstream_unreachable"] as const;

export function providerFailureDetail(err: unknown): Record<string, unknown> {
  const e = err as {
    code?: unknown;
    status?: number;
    response?: { status?: number; data?: unknown };
    config?: { endpoint?: string; url?: string };
  } | null;
  const detail: Record<string, unknown> = {};
  // Matched against the known literals rather than kept as any string: Node
  // hangs its own `code` on system errors (ECONNRESET and friends), and those
  // already reach here normalised into the two below by the direct transport.
  // `request_failed`, the third DirectTransportError code, is deliberately not
  // here: it says nothing that `status` does not say better.
  if (TRANSPORT_CODES.some((c) => c === e?.code)) detail.code = e?.code;
  const status = e?.response?.status ?? e?.status;
  if (typeof status === "number") detail.status = status;
  const endpoint = e?.config?.endpoint ?? e?.config?.url;
  if (typeof endpoint === "string" && endpoint) detail.endpoint = endpoint;
  const body = e?.response?.data;
  if (body !== undefined && body !== null) {
    let text: string;
    try {
      text = typeof body === "string" ? body : JSON.stringify(body);
    } catch {
      // Circular or otherwise unserialisable: the shape still beats nothing.
      text = String(body);
    }
    // Clipped: a provider error page can run to kilobytes, and the first line
    // carries the reason. `text` is a string on both paths above, so it needs
    // no further guard.
    detail.response = text.slice(0, 500);
  }
  return detail;
}
