import { after } from "next/server";
import { ingestBulletsIntoGraph } from "./graph-ingest";

/**
 * Schedule knowledge-graph ingestion of freshly saved memory bullets to run
 * AFTER the HTTP response is sent — same rationale as scheduleVaultSync: on
 * Vercel a bare fire-and-forget promise is frozen when the response
 * flushes, while `after()` keeps the invocation alive until the callback
 * settles. `ingestBulletsIntoGraph` owns its own try/catch and never throws.
 */
export function scheduleGraphIngest(businessId: string, bullets: string[]): void {
  after(() => ingestBulletsIntoGraph(businessId, bullets));
}
