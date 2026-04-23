/**
 * Client-side companion to `src/lib/api-response.ts`.
 *
 * The server envelope is `{ ok: true, data }` on success and
 * `{ ok: false, error: { code, message } }` on failure. Every browser fetch
 * against our own Next.js API routes goes through `parseEnvelope`, which
 * (a) always returns the envelope shape (never throws) and
 * (b) synthesises a canonical INTERNAL_SERVER_ERROR when the body is missing
 *     or not JSON, so callers can narrow on `ok` without a try/catch.
 *
 * Kept separate from `api-response.ts` because that file imports
 * `next/server` (Node-only) and cannot be pulled into a `"use client"`
 * component.
 */

export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export async function parseEnvelope<T>(res: Response): Promise<ApiEnvelope<T>> {
  try {
    return (await res.json()) as ApiEnvelope<T>;
  } catch {
    return {
      ok: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Unexpected server response"
      }
    };
  }
}
