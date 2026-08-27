---
name: project_contacts_are_phone_keyed
description: "contacts.customer_e164 is the contact KEY, not a phone: E.164, a short code, or (since PR #1464) email:<addr>. Parse it with _shared/contact_key.ts and never assume it is dialable"
metadata:
  type: project
---

`contacts` is unique on `(business_id, customer_e164)` and that column is the
identity, not an attribute. It was never only a phone number, and since
**PR #1464 (merged 2026-08-18)** it holds one of three shapes:

| Shape | Example |
| --- | --- |
| E.164 number | `+16025551234` |
| bare 3-8 digit short code | `73339` (lead sources text from these) |
| email key | `email:val@example.com` |

`supabase/functions/_shared/contact_key.ts` is the single vocabulary, imported
by both the Edge worker and the Next app: `emailContactKey`, `contactKeyEmail`,
`classifyContactKey`, `isDialableContactKey`, `formatContactKey`,
`contactAliasOrFilter`.

**Two rules that are easy to get wrong:**

1. **Never assume the key is dialable.** Gate any send that starts from a
   contact ROW on `isDialableContactKey`. The `email:` prefix makes every
   existing digits-and-plus validator refuse the key, so untaught code fails
   closed, but code that reads the column raw does not.
2. **Never put an email key in a PostgREST `.or()` filter.** Use
   `contactAliasOrFilter`, which returns null for an email key so the caller
   uses `.eq("customer_e164", key)`. `alias_e164s` only ever collects NUMBERS a
   merge folded away, so the alias arm could not match an address anyway.

A DB CHECK (`contacts_email_key_matches_email`) ties an `email:<addr>` row to
`<addr>` in its own `email` column, and `record_customer_interaction` fills that
column itself. That is why `findCustomerByEmail`, `findContactsByEmails`, the
campaign audience builder and marketing-unsubscribe all see email-keyed
contacts with no query changes.

**Flows can file one since PR #1473** (merged 2026-08-18). `upsert_customer`
and `update_contact` both fall back to `emailVar` when `phoneVar` resolves to
nothing usable; `phoneVar` stays REQUIRED on both, so no flow definition
changed shape. Five downstream guards had to learn the same lesson, every one
of them a SILENT failure: the staff-contact check (compare the address to the
roster's emails), the duplicate-lead guard (match the address on the flow's own
email var, not `lead_phone`), first-contact language persist (its INSERT needs
`email`), `contact_created` hydration (skipped everything non-E.164, so no tags
line), and three alias `.or()` lookups.

**Addresses are compared case-insensitively, always.** `contactKeyEmail`
lowercases; roster emails and prior runs' extracted vars keep whatever casing
they arrived with, so a database-side equality silently never matches. Use
`emailIlikePattern` (escapes `%` `_` `\`) for a filter, or compare lowercased
in JS. `*` is REFUSED by `EMAIL_KEY_RE` rather than escaped: PostgREST turns it
into `%` while parsing, before SQL sees it.

**Still phone-only, deliberately:** merge (`merge_customer_memories` records the
folded key in `alias_e164s`) and the SMS reply-mode toggle.

**Live wiring, checked 2026-08-18:** Amy's `Clever Lead - Accept` and `New Lead
Intake` already pass `emailVar` to `upsert_customer`, so they file phoneless
leads with no flow edit. `ReferralExchange Lead` and `Realtor.com Lead` have NO
`upsert_customer` step at all, so they still file nothing: they need one added
before an email-only lead there becomes a contact. See
[[project_amy_email_followup_cadence]] and
[[feedback_check_for_a_shared_mechanism_first]].
