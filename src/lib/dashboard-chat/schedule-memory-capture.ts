import { after } from "next/server";
import { captureOwnerRuleInline } from "./memory-capture";

/**
 * Schedule the silent owner-rule capture (and the knowledge-graph ingest it
 * chains into) to run AFTER the HTTP response is sent — same rationale as
 * scheduleVaultSync: on Vercel a bare fire-and-forget promise is frozen the
 * moment the response flushes, so `void captureOwnerRuleInline(...)` could
 * persist bullets yet silently skip (or never start) the rest of the
 * pipeline. `captureOwnerRuleInline` owns its own try/catch and never
 * throws.
 */
export function scheduleCaptureOwnerRuleInline(args: {
  businessId: string;
  ownerMessage: string;
  assistantReply?: string;
}): void {
  after(() => captureOwnerRuleInline(args));
}
