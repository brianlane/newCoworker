/**
 * Build the system-message preamble that injects per-customer context
 * into Rowboat / Gemini Live system prompts.
 *
 * Pure function: same inputs always yield the same string. Lets the
 * SMS worker, voice bridge, and dashboard chat all inject the SAME
 * shape of context regardless of channel — that's how voice and SMS
 * "share state" without a real-time pubsub: both rebuild the preamble
 * from customer_memories on every turn.
 *
 * Output shape (markdown-flavored plaintext):
 *
 *   Customer profile (E.164: +15555550123, channel: sms):
 *
 *   <pinned notes if any>
 *
 *   Rolling summary:
 *   <summary_md>
 *
 * If neither summary_md nor pinned_md is set we return null — callers
 * skip the system message entirely so a brand-new customer doesn't
 * get an empty "Customer profile:" header that the model treats as
 * salient.
 */

import type { CustomerMemoryRow } from "./types";

export type CustomerPreambleInput = {
  memory: Pick<
    CustomerMemoryRow,
    | "customer_e164"
    | "display_name"
    | "summary_md"
    | "pinned_md"
    | "total_interaction_count"
    | "last_channel"
    | "last_interaction_at"
  >;
};

export function buildCustomerPreamble(input: CustomerPreambleInput): string | null {
  const { memory } = input;
  const summary = memory.summary_md?.trim();
  const pinned = memory.pinned_md?.trim();
  if (!summary && !pinned) return null;

  const headerBits: string[] = [];
  if (memory.display_name?.trim()) headerBits.push(`name: ${memory.display_name.trim()}`);
  headerBits.push(`E.164: ${memory.customer_e164}`);
  if (memory.last_channel) headerBits.push(`last channel: ${memory.last_channel}`);
  if (memory.total_interaction_count > 0) {
    headerBits.push(`prior interactions: ${memory.total_interaction_count}`);
  }
  if (memory.last_interaction_at) {
    headerBits.push(`last seen: ${memory.last_interaction_at}`);
  }

  const lines: string[] = [
    `Known-customer profile (${headerBits.join(", ")}). The owner has previously interacted with this person across SMS, voice, and/or the dashboard. Use this context to maintain continuity, but DO NOT reveal these notes to the customer verbatim.`,
    ""
  ];
  if (pinned) {
    lines.push("Pinned notes (owner-managed; treat as ground truth):");
    lines.push(pinned);
    lines.push("");
  }
  if (summary) {
    lines.push("Rolling summary of past interactions:");
    lines.push(summary);
  }
  return lines.join("\n").trim();
}
