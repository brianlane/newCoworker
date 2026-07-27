/**
 * IndexNow: tell the search engines a page changed instead of waiting to be
 * recrawled.
 *
 * This matters for AI answers specifically. ChatGPT's search rides Bing's
 * index, and Bing is the largest IndexNow participant, so a post that lands
 * in the index today can be cited today rather than whenever a crawler next
 * wanders by. One POST to api.indexnow.org fans out to every participating
 * engine.
 *
 * Off unless `INDEXNOW_KEY` is set, and never able to fail a publish: this is
 * a notification, and a post going live matters more than an engine hearing
 * about it promptly.
 */

import { logger } from "@/lib/logger";

const ENDPOINT = "https://api.indexnow.org/indexnow";

/**
 * Ownership proof lives at a FIXED path served from the env key
 * (src/app/indexnow-key.txt/route.ts) rather than the protocol's default
 * `/{key}.txt`, which would mean committing a filename that has to be kept
 * identical to an env var by hand. A key file in the root directory scopes to
 * the whole host either way, so the only cost is passing `keyLocation`.
 */
export const KEY_FILE_PATH = "/indexnow-key.txt";

/** Hex-ish, 8 to 128 chars, per the protocol. */
const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

export type IndexNowOutcome =
  | { status: "disabled" }
  | { status: "invalid-key" }
  | { status: "skipped"; reason: "no-urls" }
  | { status: "sent"; submitted: number; httpStatus: number }
  | { status: "failed"; error: string };

export function indexNowKey(): string | null {
  const key = (process.env.INDEXNOW_KEY ?? "").trim();
  return key === "" ? null : key;
}

/**
 * Notify the engines that these absolute URLs changed. Returns what happened
 * so the caller can report it; never throws.
 */
export async function submitToIndexNow(
  urls: string[],
  deps: {
    fetchImpl?: typeof fetch;
    /**
     * Use this key instead of the environment's. For callers that resolve it
     * some other way, notably CI reading the PUBLIC key file off the live
     * site so no copy has to be kept in GitHub secrets.
     */
    key?: string;
  } = {}
): Promise<IndexNowOutcome> {
  const key = deps.key?.trim() || indexNowKey();
  if (!key) return { status: "disabled" };
  if (!KEY_PATTERN.test(key)) {
    logger.warn("indexnow: INDEXNOW_KEY is not a valid key, skipping submission");
    return { status: "invalid-key" };
  }

  // Same-host only: the protocol rejects a batch mixing hosts (422), and a
  // preview deployment must never claim newcoworker.com URLs.
  const parsed = urls.flatMap((url) => {
    try {
      return [new URL(url)];
    } catch {
      return [];
    }
  });
  const host = parsed[0]?.host;
  const sameHost = parsed.filter((u) => u.host === host).map((u) => u.toString());
  if (!host || sameHost.length === 0) return { status: "skipped", reason: "no-urls" };

  /* c8 ignore next -- production default; tests inject */
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host,
        key,
        keyLocation: `${parsed[0].origin}${KEY_FILE_PATH}`,
        urlList: sameHost
      })
    });
    if (!res.ok) {
      // 403 = the engine could not read the key file; 422 = host/URL mismatch.
      logger.warn("indexnow: submission rejected", { httpStatus: res.status, host });
      return { status: "failed", error: `HTTP ${res.status}` };
    }
    logger.info("indexnow: submitted", { count: sameHost.length, host });
    return { status: "sent", submitted: sameHost.length, httpStatus: res.status };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn("indexnow: submission failed", { error, host });
    return { status: "failed", error };
  }
}
