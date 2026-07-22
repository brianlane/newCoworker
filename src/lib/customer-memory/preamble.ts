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

/**
 * The name the assistant should ADDRESS someone by: the first
 * whitespace-separated word of their stored name, politely cased.
 *
 * Why (Truly, Jul 21 2026): lead forms deliver raw full names like
 * "shabir gulamhussein lukmanji", and the assistant parroted the entire
 * lowercase string in 9 of 12 replies. Casing is only corrected when the
 * token carries none of its own — all-lowercase, or all-UPPERCASE beyond
 * initials length — so "McKenna", "DeSouza", and initials like "JD"
 * survive untouched.
 *
 * Duplicated in supabase/functions/_shared/customer_memory_preamble.ts
 * (the Deno twin cannot import src/) — the parity test pins both.
 */
export function politeFirstName(displayName: string): string {
  const trimmed = displayName.trim();
  const space = trimmed.search(/\s/);
  const first = space === -1 ? trimmed : trimmed.slice(0, space);
  if (first.length === 0) return first;
  if (first === first.toLowerCase() || (first === first.toUpperCase() && first.length >= 4)) {
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  }
  return first;
}

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
  const name = memory.display_name?.trim();
  // A stored display name alone is worth a preamble: without the addressing
  // line the model greets with whatever a lead form carried (Truly Issue 6:
  // "Muhammad Fahad Juhu" instead of the stored "Juhu").
  if (!summary && !pinned && !name) return null;

  const headerBits: string[] = [];
  if (name) headerBits.push(`name: ${name}`);
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
  if (name) {
    const addressAs = politeFirstName(name);
    // The full-name aside exists for MULTI-WORD stored names (the first name
    // alone loses information); a single-word name that was merely re-cased
    // ("john" → "John") is not a "full name" and gets no aside (Bugbot Low
    // on PR #823).
    const stored = /\s/.test(name) ? ` (their stored full name is "${name}")` : "";
    lines.push(
      `Address this person as "${addressAs}"${stored} — use that name SPARINGLY (most replies need no name at all) and never recite their full name in normal conversation. The stored name takes precedence over any different or longer name that appears in lead forms, automation context, earlier messages, or the pinned notes and rolling summary below (unless they explicitly ask you to use another name).`
    );
    lines.push("");
  }
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
