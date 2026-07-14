/**
 * Edge-runtime mirror of src/lib/customer-memory/preamble.ts.
 *
 * Why duplicate: Deno edge functions can't `import` from src/ (no
 * tsconfig path mapping in the worker bundle), and reaching across
 * the runtime boundary at build time is more complex than vendoring
 * a 30-line pure helper. The Next.js version stays the canonical one
 * because the dashboard-chat awareness path (Phase 4) and the
 * customers UI both consume it; this copy is read-only twin.
 *
 * If the shape changes, update both. The tests in
 * tests/customer-memory.test.ts cover the Next.js side and
 * tests/customer-memory-preamble-parity.test.ts pins the two
 * implementations against each other so a one-sided edit is loud.
 */

export type EdgeCustomerMemoryChannel = "sms" | "voice" | "dashboard";

export type EdgeCustomerMemoryRow = {
  customer_e164: string;
  display_name: string | null;
  summary_md: string | null;
  pinned_md: string | null;
  total_interaction_count: number;
  last_channel: EdgeCustomerMemoryChannel | null;
  last_interaction_at: string | null;
};

export function buildCustomerPreambleForEdge(memory: EdgeCustomerMemoryRow): string | null {
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
    lines.push(
      `Address this person as "${name}" — this is their stored preferred name and takes precedence over any different or longer name that appears in lead forms, automation context, earlier messages, or the pinned notes and rolling summary below (unless they explicitly ask you to use another name).`
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
