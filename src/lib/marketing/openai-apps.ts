/**
 * OpenAI Apps (ChatGPT plugin) domain verification.
 *
 * The submission portal at platform.openai.com/plugins issues a token and
 * asks us to serve it as PLAIN TEXT at a fixed `.well-known` path on the host
 * that serves our MCP server. It proves we control the domain, the same job
 * the IndexNow key file does for the search engines
 * (src/lib/marketing/indexnow.ts).
 *
 * Verification is per HOST, not per path: OpenAI ignores the path of the
 * submitted MCP URL, so one token covers `/api/mcp` and every future
 * `/api/mcp/*` route we add.
 *
 * Off unless `OPENAI_APPS_CHALLENGE_TOKEN` is set, so the route 404s rather
 * than serving an empty body that reads to a reviewer as a broken endpoint.
 */

import { logger } from "@/lib/logger";

/**
 * Where the token is served. Fixed by OpenAI; the portal also shows it as the
 * "challenge URL" alongside the token, so this must not drift.
 */
export const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

/** Plausible opaque-token length. Deliberately wide: OpenAI documents no format. */
const MIN_TOKEN_LENGTH = 8;
const MAX_TOKEN_LENGTH = 256;

/**
 * The verification token, or null when the feature is off or the configured
 * value cannot be a token.
 *
 * The two rejections both come straight from OpenAI's documented constraint
 * that the response body is "a plain text token, not JSON, a list, or
 * multiple tokens". Both are paste errors an operator makes once and then
 * spends an afternoon debugging, because the portal reports only that
 * verification failed:
 *
 *   - whitespace anywhere means a list, a wrapped line, or a stray newline,
 *   - a leading `{` or `[` means the whole JSON blob got pasted (and a
 *     minified blob contains no whitespace, so the first check misses it).
 *
 * Serving a bad value would 200 with a body OpenAI rejects. Returning null
 * 404s instead, which is the honest signal and is visible with one curl.
 */
export function openAiAppsChallengeToken(): string | null {
  const token = (process.env.OPENAI_APPS_CHALLENGE_TOKEN ?? "").trim();
  if (token === "") return null;

  if (/\s/.test(token)) {
    logger.warn("openai-apps: OPENAI_APPS_CHALLENGE_TOKEN contains whitespace, refusing to serve it");
    return null;
  }
  if (token.startsWith("{") || token.startsWith("[")) {
    logger.warn("openai-apps: OPENAI_APPS_CHALLENGE_TOKEN looks like JSON, refusing to serve it");
    return null;
  }
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    logger.warn("openai-apps: OPENAI_APPS_CHALLENGE_TOKEN is not a plausible token length, refusing to serve it");
    return null;
  }

  return token;
}
