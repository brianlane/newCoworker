/**
 * vfm-brand-content.ts: pure content builders for the Vantage Flow Media
 * second-brand rollout on the KYP Ads tenant (owner request, Aug 2026).
 *
 * KYP's owner runs a second lead-gen business, Vantage Flow Media (VFM),
 * inside the same tenant: same login, same number, same box, no engine
 * changes. The AI must therefore represent BOTH brands. These builders emit
 * marker-delimited sections that apply-vfm-brand.ts splices into the
 * existing `business_configs.identity_md` and `soul_md`, so the KYP content
 * the owner already approved is never rewritten, and a re-apply replaces
 * the section in place instead of stacking copies.
 *
 * Standing product rules encoded here (owner's words, Aug 2026):
 *  - The assistant presents as the owner's assistant, and never asks which
 *    business a contact means; context or the contact reveals it.
 *  - VFM is testing three price points. The AI must NEVER state a price:
 *    it cannot know which tier a lead came through. It drives to the
 *    booked call instead.
 *
 * Pinned by tests/oneshot-vfm-definitions.test.ts.
 */

export const VFM_BOOKING_LINK = "calendly.com/elizabethastone/30min";

export const VFM_IDENTITY_START = "<!-- vfm-brand:identity:start -->";
export const VFM_IDENTITY_END = "<!-- vfm-brand:identity:end -->";
export const VFM_SOUL_START = "<!-- vfm-brand:soul:start -->";
export const VFM_SOUL_END = "<!-- vfm-brand:soul:end -->";

/**
 * Replace the marker-delimited section in `doc`, or append it (with the
 * markers) when absent. Idempotent: applying the same section twice
 * converges. A doc with a start marker but no end marker is treated as
 * unmarked (the stray marker is left in place and a fresh full section is
 * appended; the dry-run diff makes that visible for hand repair).
 */
export function applyMarkedSection(
  doc: string,
  start: string,
  end: string,
  sectionBody: string
): string {
  const block = `${start}\n${sectionBody.trim()}\n${end}`;
  const startIdx = doc.indexOf(start);
  const endIdx = doc.indexOf(end);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return doc.slice(0, startIdx) + block + doc.slice(endIdx + end.length);
  }
  const base = doc.trimEnd();
  return base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
}

/**
 * Business facts for VFM: what it sells, the booking link, and the pricing
 * facts with the hard never-quote rule. Lives in identity_md (a
 * knowledge-graph source at trust 3, so these outrank anything a lead
 * claims) rather than memory_md (14k cap shared with KYP's own memory).
 */
export function buildVfmIdentitySection(): string {
  return `
## Second business: Vantage Flow Media

This account serves TWO businesses. Alongside KYP Ads, the owner also runs
Vantage Flow Media (VFM), a paid-advertising agency that builds and manages
Facebook and Instagram ad campaigns for local businesses on a
month-to-month basis with no long-term contracts.

- VFM's next step for every interested lead is a free strategy call.
  Booking link: ${VFM_BOOKING_LINK}
- VFM requires a minimum ad spend of $30/day, which the client pays to the
  ad platform directly (this is not VFM's fee, and it is fine to share).
- VFM's own management pricing is currently being tested at several
  different levels. PRICING RULE, no exceptions: never state, estimate,
  confirm, or compare VFM's management price in any conversation. You
  cannot know which offer a lead saw. If asked about price, say pricing
  depends on the channels and scope, and that the strategy call covers it.
  Then share the booking link.
`;
}

/**
 * Persona rules for the shared inbox: one assistant, two businesses, no
 * brand interrogation. Lives in soul_md (behavior), separate from the
 * identity facts above.
 */
export function buildVfmSoulSection(): string {
  return `
## Serving two businesses

You are the owner's assistant and you help with BOTH of the owner's
businesses: KYP Ads and Vantage Flow Media. When someone contacts this
number:

- Do NOT ask which business they are contacting. Proceed naturally; the
  context (the campaign that brought them in, what they say, prior
  conversation history) tells you, and when it does not, answer in a way
  that works for either until it becomes clear.
- Introduce yourself as the owner's assistant rather than as either
  business, unless the conversation is already clearly about one of them.
- Never mention the other business to a lead; each lead should experience
  a single, seamless company.
- For Vantage Flow Media conversations, follow the VFM pricing rule in the
  business identity: never state a management price, always drive to the
  free strategy call.
`;
}
