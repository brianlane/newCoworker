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
/**
 * What every author-written free-text field is replaced with in the public
 * library. The library publishes only a flow's machine STRUCTURE (step/trigger
 * types, conditions, var + field names, numeric/time/enum settings, recipient
 * placeholders); all natural-language prose a human typed (message bodies,
 * subjects, prompts, templates, descriptions, labels, condition/comparison
 * values) is blanked to this token so it can never leak personal or business
 * details. A duplicator fills in their own copy in the editor. Kept short +
 * non-empty so the result still satisfies the per-field schema min/max lengths.
 */
export const LIBRARY_STRIPPED_PLACEHOLDER = "[edit after copying]";

/**
 * Object keys whose string value is author-written prose (vs. structural data).
 * Every occurrence anywhere in the definition tree is blanked to
 * `LIBRARY_STRIPPED_PLACEHOLDER`. Keyed by name (not step type) so it's robust
 * to nesting (quietHours.emailSubject, when.equals, conditions[].value, ...).
 */
const PROSE_KEYS: ReadonlySet<string> = new Set([
  "body",
  "subject",
  "message",
  "prompt",
  "offerTemplate",
  "ownerFallbackTemplate",
  "claimedNotifyTemplate",
  "bodyTemplate",
  "valueTemplate",
  "label",
  "description",
  "emailSubject",
  "integrationLabel",
  // A branch step's question is author prose (its arm labels blank via "label").
  "question",
  // Trigger condition (`value`) and per-step gate (`equals`/`contains`/
  // `notEquals`) comparison literals — free text that can carry names/
  // addresses/locations.
  "value",
  "equals",
  "contains",
  "notEquals"
]);

function blankProse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(blankProse);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PROSE_KEYS.has(k) && typeof v === "string" ? LIBRARY_STRIPPED_PLACEHOLDER : blankProse(v);
    }
    return out;
  }
  return value;
}

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
 * Three passes:
 *   1. deep text redaction over every string (phones/emails/known names) — this
 *      mainly covers the recipient fields that survive (`to`/`cc`/`bcc`);
 *   2. blank every author-written prose field (`blankProse`) so no message
 *      body, subject, template, prompt, description, label, or condition value
 *      is ever published — only the flow's structure remains; and
 *   3. structural fixups for tenant-specific fields (mailbox connection ids ->
 *      blanked, pinned roster members -> placeholders, http endpoints dropped).
 * The result is intended for display + later substitution, not for direct schema
 * parsing (the placeholders resolve once `applyLibrarySubstitutions` runs).
 */
export function scrubDefinition(
  def: AiFlowDefinition,
  opts: ScrubOptions = {}
): Record<string, unknown> {
  const knownNames = opts.knownNames ?? [];
  const clone = JSON.parse(JSON.stringify(def)) as Record<string, unknown>;
  const redacted = deepRedact(clone, knownNames);
  const scrubbed = blankProse(redacted) as Record<string, unknown>;

  // Structural fixups (applied AFTER redaction so they aren't re-mangled): drop
  // or neutralize tenant-specific ids and pinned people.
  const trigger = scrubbed.trigger as Record<string, unknown>;
  if (trigger.channel === "email" && typeof trigger.connectionId === "string") {
    // A specific mailbox uuid — blank to a schema-valid nil so the duplicating
    // user re-points it to their own connected inbox in the editor.
    trigger.connectionId = NIL_UUID;
  }

  // `def` is a parsed AiFlowDefinition, so steps is always an array (preserved
  // through the JSON clone + deep redaction above). Recurse into branch arms
  // so a nested send/route/http step gets the same fixups as a trunk step.
  const fixupSteps = (steps: Record<string, unknown>[]): void => {
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
        case "http_call":
          // The endpoint `path` and `bodyTemplate` can embed webhook URLs, API
          // keys, or bearer tokens — tenant secrets that must never reach the
          // cross-tenant library. Drop them; the duplicating user re-enters their
          // own endpoint in the editor.
          delete step.path;
          delete step.bodyTemplate;
          break;
        case "branch": {
          // `def` is a parsed AiFlowDefinition, so arms/else are always arrays.
          for (const arm of step.branches as Array<{ steps: Record<string, unknown>[] }>) {
            fixupSteps(arm.steps);
          }
          fixupSteps(step.else as Record<string, unknown>[]);
          break;
        }
        default:
          break;
      }
    }
  };
  fixupSteps(scrubbed.steps as Record<string, unknown>[]);

  return scrubbed;
}

// Phone-like run: a digit, then 7+ phone characters, then a digit (>= 9 digits
// of separators). Same shape as the redaction regex; long enough to skip times
// ("22:00"), counts, and bounded settings (responseMinutes, everyMinutes, ...).
const PHONE_LIKE_RE = /\(?\+?\d(?:[\d\s().-]{7,})\d/;
const EMAIL_LIKE_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const ANY_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Defense-in-depth gate for the refresh job: returns true if a scrubbed
 * definition STILL contains a literal email or phone number. UUIDs (e.g. the
 * blanked NIL connection id) are stripped first so they don't read as a phone.
 * The refresh skips publishing any template that trips this, so even a future
 * prose field that slips past `scrubDefinition` can't leak structured PII.
 */
export function containsLikelyPii(value: unknown): boolean {
  const json = (JSON.stringify(value) ?? "").replace(ANY_UUID_RE, "");
  return EMAIL_LIKE_RE.test(json) || PHONE_LIKE_RE.test(json);
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
