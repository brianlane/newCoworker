/**
 * The definition patch applied by patch-clever-spoke-check-unclaimed-leads.ts.
 *
 * Kept separate from the one-shot for the same reason
 * clever-spoke-check-definition.ts is: the script calls loadEnv() and builds a
 * Supabase client at import time, so the unit suite can only reach this logic
 * if it lives in a module of its own.
 *
 * See the one-shot's header for why the second trigger is tag_changed rather
 * than the intuitive contact_created, and why allowReentry is not optional.
 */
import type { AiFlowDefinition } from "../../src/lib/ai-flows/schema.ts";

/** Max extra triggers the flow schema accepts alongside the primary one. */
const MAX_EXTRA_TRIGGERS = 4;

type AnyTrigger = { channel?: string; tag?: string; change?: string };

/** Is this already the Clever tag_changed trigger, whatever its casing? */
function isCleverTagTrigger(t: AnyTrigger | undefined, tag: string): boolean {
  return (
    t?.channel === "tag_changed" &&
    (t.tag ?? "").trim().toLowerCase() === tag.trim().toLowerCase() &&
    (t.change ?? "added") === "added"
  );
}

/**
 * Add the tag_changed trigger and close the double-enrollment hole.
 *
 * Idempotent: re-running against an already-patched definition returns it
 * unchanged with an empty change list. Throws rather than guessing when the
 * flow does not look like the spoke check, or when a later edit has already
 * used up the extra-trigger slots.
 */
export function patchSpokeCheckForUnclaimedLeads(
  def: AiFlowDefinition,
  opts: { cleverTag: string }
): { next: AiFlowDefinition; changes: string[] } {
  const changes: string[] = [];
  let next = def;

  const primary = (next as { trigger?: AnyTrigger }).trigger;
  const extras = ((next as { triggers?: AnyTrigger[] }).triggers ?? []) as AnyTrigger[];

  // The owner_assigned trigger stays: it still catches a lead assigned by a
  // path that never wrote the tag, such as a manual owner pick on the contact
  // page. allowReentry is what keeps the pair from double-enrolling anyone.
  if (primary?.channel !== "owner_assigned") {
    throw new Error(
      "expected the primary trigger to be owner_assigned, found " +
        `"${primary?.channel ?? "none"}", is this the spoke-check flow?`
    );
  }

  if (
    !isCleverTagTrigger(primary, opts.cleverTag) &&
    !extras.some((t) => isCleverTagTrigger(t, opts.cleverTag))
  ) {
    // Refuse rather than silently drop a trigger someone else added.
    if (extras.length >= MAX_EXTRA_TRIGGERS) {
      throw new Error(
        `flow already carries ${extras.length} extra triggers (max ${MAX_EXTRA_TRIGGERS}), ` +
          "remove one before adding the tag_changed trigger."
      );
    }
    next = {
      ...next,
      triggers: [
        ...extras,
        { channel: "tag_changed", tag: opts.cleverTag, change: "added", conditions: [] }
      ]
    } as AiFlowDefinition;
    changes.push(`added tag_changed trigger on "${opts.cleverTag}" (change=added)`);
  }

  const options = (next as { options?: { allowReentry?: boolean } }).options;
  if (options?.allowReentry !== false) {
    next = {
      ...next,
      options: { ...(options ?? {}), allowReentry: false }
    } as AiFlowDefinition;
    changes.push("set options.allowReentry=false (blocks double enrollment)");
  }

  return { next, changes };
}
