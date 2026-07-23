/**
 * Dashboard-chat turn routing: central Gemini is the PRIMARY engine, the
 * per-tenant VPS chat-worker is the FALLBACK.
 *
 * Historically every owner turn was enqueued to the VPS worker (which
 * itself ran Gemini-under-cap via Rowboat, local model over cap). That made
 * the tenant's box a hard dependency of every dashboard reply. Now the
 * platform answers directly with Gemini when it can, and the worker queue
 * remains for: budget-exhausted turns (the worker owns the local-model
 * degrade), a missing platform API key, and inline-call failures (the
 * caller enqueues after a failed inline attempt).
 *
 * Attachment turns can never fall back — the local model cannot read PDFs
 * and the worker input protocol is text-only — so over-budget/unconfigured
 * attachment turns are refused with an honest message instead.
 */

import type { ChatSpendSnapshot } from "@/lib/db/chat-usage";

export type ChatTurnRoute =
  | { kind: "inline" }
  | { kind: "worker" }
  | { kind: "refuse"; message: string };

export const ATTACHMENT_OVER_BUDGET_MESSAGE =
  "Your coworker's monthly AI budget is used up, and reading attachments needs the cloud model. " +
  "Attachment replies resume when your billing period resets, or add a Gemini credit pack from the Billing page.";

export const ATTACHMENT_NOT_CONFIGURED_MESSAGE =
  "Attachment understanding isn't available right now, send the message without the attachment, or try again later.";

export function resolveChatTurnRoute(args: {
  hasAttachment: boolean;
  apiKeyPresent: boolean;
  /** Null when the spend read failed — fail OPEN to inline (quality over fuse on a transient DB blip, same posture as the worker). */
  spend: ChatSpendSnapshot | null;
}): ChatTurnRoute {
  const overCap = args.spend !== null && args.spend.spendMicros >= args.spend.effectiveCapMicros;
  if (!args.apiKeyPresent) {
    if (args.hasAttachment) {
      return { kind: "refuse", message: ATTACHMENT_NOT_CONFIGURED_MESSAGE };
    }
    return { kind: "worker" };
  }
  if (overCap) {
    if (args.hasAttachment) {
      return { kind: "refuse", message: ATTACHMENT_OVER_BUDGET_MESSAGE };
    }
    // The worker owns the over-cap path: it degrades to the tenant's local
    // model (or refuses honestly on no-local-model hosts).
    return { kind: "worker" };
  }
  return { kind: "inline" };
}
