/**
 * PII scrubbing + grouping for the public AiFlow library (pure helpers).
 *
 * A flow `definition` authored by a tenant can contain real personal data:
 * literal phone numbers and email addresses baked into send steps, the owner's
 * or a teammate's name in copy, a pinned roster member, and tenant-specific
 * mailbox connection ids. Before a flow is exposed in the cross-tenant public
 * library it MUST be run through `scrubDefinition`, which replaces that PII with
 * neutral placeholders. The library only ever stores the scrubbed result; the
 * raw definition never leaves the owning tenant.
 *
 * The placeholder tokens round-trip with `applyLibrarySubstitutions`, which a
 * user's "duplicate from library" flow uses to drop their own phone / email /
 * teammate back in. Kept pure (no IO) so it sits under the `src/lib/**`
 * coverage gate and both the refresh job and the duplicate route can share it.
 */
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

/** Placeholder a scrubbed literal phone becomes; refilled on duplicate. */
export const OWNER_PHONE_PLACEHOLDER = "{{owner_phone}}";
/** Placeholder a scrubbed literal email becomes; refilled on duplicate. */
export const OWNER_EMAIL_PLACEHOLDER = "{{owner_email}}";
/** Placeholder a scrubbed pinned roster member becomes; refilled on duplicate. */
export const EMPLOYEE_NAME_PLACEHOLDER = "{{employee_name}}";
/** Replacement for a personal name found in free-text copy (not refilled). */
export const NAME_PLACEHOLDER = "[name]";
/** Stand-in for a blanked tenant-specific mailbox connection id (schema-valid). */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// A run of 9+ digits with optional +, leading paren, spaces, dashes, dots, and
// parens — covers E.164 (+15551234567) and common US formats ((555) 123-4567,
// 555-123-4567). The 9-char floor keeps short counts ("10 minutes", prices like
// "500000") from matching, and `{{vars.x}}` templates contain no long digit runs.
const PHONE_RE = /\(?\+?\d(?:[\d\s().-]{7,})\d/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact PII from a single free-text string: emails first (so their digits
 * can't be misread as a phone), then phones, then any caller-supplied known
 * names (owner + roster). Whole-word, case-insensitive name matching.
 */
export function redactText(text: string, knownNames: readonly string[] = []): string {
  let out = text.replace(EMAIL_RE, OWNER_EMAIL_PLACEHOLDER).replace(PHONE_RE, OWNER_PHONE_PLACEHOLDER);
  for (const raw of knownNames) {
    const name = raw.trim();
    // Skip 1-char tokens to avoid over-redacting; longer names use \b so a name
    // like "Bo" never matches inside "Bob".
    if (name.length < 2) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi"), NAME_PLACEHOLDER);
  }
  return out;
}

function deepRedact(value: unknown, knownNames: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, knownNames);
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, knownNames));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v, knownNames);
    return out;
  }
  return value;
}

type ScrubOptions = {
  /** Literal names (owner + roster) to redact from free-text copy. */
  knownNames?: readonly string[];
};

/**
 * Return a PII-scrubbed copy of a definition, safe to publish cross-tenant.
 * Two passes: a deep text redaction over every string, then structural fixups
 * for tenant-specific fields the text pass can't reason about (mailbox
 * connection ids -> blanked, pinned roster members -> placeholders). The result
 * is intended for display + later substitution, not for direct schema parsing
 * (the placeholders resolve once `applyLibrarySubstitutions` runs).
 */
export function scrubDefinition(
  def: AiFlowDefinition,
  opts: ScrubOptions = {}
): Record<string, unknown> {
  const knownNames = opts.knownNames ?? [];
  const clone = JSON.parse(JSON.stringify(def)) as Record<string, unknown>;
  const scrubbed = deepRedact(clone, knownNames) as Record<string, unknown>;

  // Structural fixups (applied AFTER redaction so they aren't re-mangled): drop
  // or neutralize tenant-specific ids and pinned people.
  const trigger = scrubbed.trigger as Record<string, unknown>;
  if (trigger.channel === "email" && typeof trigger.connectionId === "string") {
    // A specific mailbox uuid — blank to a schema-valid nil so the duplicating
    // user re-points it to their own connected inbox in the editor.
    trigger.connectionId = NIL_UUID;
  }

  // `def` is a parsed AiFlowDefinition, so steps is always an array (preserved
  // through the JSON clone + deep redaction above).
  const steps = scrubbed.steps as Record<string, unknown>[];
  for (const step of steps) {
    switch (step.type) {
      case "send_email":
        // Sender mailbox is tenant-specific; default the copy back to the AI
        // coworker's own mailbox by dropping the connection binding.
        delete step.fromConnectionId;
        break;
      case "send_sms": {
        const qh = step.quietHours as Record<string, unknown> | undefined;
        if (qh) delete qh.emailFromConnectionId;
        if (typeof step.toAgentName === "string") step.toAgentName = EMPLOYEE_NAME_PLACEHOLDER;
        break;
      }
      case "route_to_team":
        // Pinning to one named agent is tenant-specific; default to roster
        // rotation by dropping the pin.
        delete step.agentName;
        break;
      default:
        break;
    }
  }

  return scrubbed;
}

type SubstituteOptions = {
  ownerPhone?: string | null;
  ownerEmail?: string | null;
  employeeName?: string | null;
};

function deepSubstitute(value: unknown, replacements: ReadonlyArray<[string, string]>): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const [token, repl] of replacements) out = out.split(token).join(repl);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => deepSubstitute(v, replacements));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepSubstitute(v, replacements);
    return out;
  }
  return value;
}

/**
 * Fill a scrubbed library definition's placeholders with the duplicating
 * business's own details. Only placeholders with a provided value are replaced;
 * anything left over (e.g. no roster member) stays as the placeholder so the
 * user can finish it in the editor. Returns a plain object to hand to
 * `parseAiFlowDefinition`.
 */
export function applyLibrarySubstitutions(
  scrubbed: unknown,
  opts: SubstituteOptions
): unknown {
  const replacements: Array<[string, string]> = [];
  if (opts.ownerPhone) replacements.push([OWNER_PHONE_PLACEHOLDER, opts.ownerPhone]);
  if (opts.ownerEmail) replacements.push([OWNER_EMAIL_PLACEHOLDER, opts.ownerEmail]);
  if (opts.employeeName) replacements.push([EMPLOYEE_NAME_PLACEHOLDER, opts.employeeName]);
  if (replacements.length === 0) return scrubbed;
  return deepSubstitute(scrubbed, replacements);
}

/** True if any library placeholder still remains anywhere in the value. */
export function hasUnresolvedPlaceholders(value: unknown): boolean {
  const tokens = [OWNER_PHONE_PLACEHOLDER, OWNER_EMAIL_PLACEHOLDER, EMPLOYEE_NAME_PLACEHOLDER];
  const json = JSON.stringify(value) ?? "";
  return tokens.some((t) => json.includes(t));
}

/**
 * Stable grouping key for a flow, so the same template authored across many
 * tenants (e.g. each business's "ReferralExchange lead") collapses into one
 * library entry whose stats aggregate every copy. Derived from the normalized
 * name; a trailing "(copy)" suffix is stripped so duplicates group with their
 * original.
 */
export function templateKeyFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\(copy(?:\s*\d+)?\)\s*$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
