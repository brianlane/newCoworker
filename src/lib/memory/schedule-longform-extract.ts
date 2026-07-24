import { after } from "next/server";
import { extractLongFormGraph, type LongFormExtractInput } from "./graph-longform";

/**
 * Schedule long-form knowledge-graph extraction (document body, website
 * knowledge, identity markdown) to run AFTER the HTTP response is sent —
 * same rationale as scheduleVaultSync: on Vercel a bare fire-and-forget
 * promise is frozen when the response flushes, while `after()` keeps the
 * invocation alive until the callback settles. A chunked extraction can
 * take tens of seconds; the caller's save must never wait on it.
 * `extractLongFormGraph` owns its own try/catch and never throws.
 */
export function scheduleLongFormGraphExtract(
  businessId: string,
  input: LongFormExtractInput
): void {
  after(() => extractLongFormGraph(businessId, input));
}
