---
name: check-for-a-shared-mechanism-first
description: "My recurring error class is building a narrow version of something that already exists; grep the repo for it, and remember an unrun one-shot leaves no trace in live data"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 084428b0-2add-4cc2-bf15-891743d1d440
  modified: 2026-08-04T15:53:33.816Z
---

Across the auto-reload work (PRs #1156, #1163, #1168) Bugbot found
thirteen real defects. The logic and the money-safety design held up;
almost every miss was at a **seam between systems**, and each one was a
correct decision expressed in a form the receiving system could not act
on:

- wrote `task_type` in a notification payload when the reader wants
  camelCase `taskType`, so the deep link silently never fired
- used Stripe's `after_submit` slot for consent text that must be read
  *before* clicking, when `submit` is the "alongside the button" slot
- passed a `submitLabel` to Stripe Checkout, which has no button-label
  override at all
- built `emailCta` to point one channel at billing, when the dispatcher
  already had `ctaPath` driving the email button, the fallback link, and
  the SMS link together. Bugbot then caught the SMS I forgot, which the
  general mechanism would have handled for free

**The variant that cost most, 2026-08-24: an UNRUN one-shot leaves no
trace in the data, so the live system is not evidence it does not exist.**
Amy asked for voicemails on the Clever seller calls. I swept every
`place_ai_call` on her account, found thirteen with no `voicemailTemplate`,
wrote a one-shot for three of them, applied it, and reported the other ten to
her as open questions needing her copy decisions, including a Spanish
voicemail I said I would not write unprompted. Bugbot then pointed at
`scripts/oneshot/amy-voicemail-scripts.ts`, merged five days earlier, which
covers all THIRTEEN in one pass, Spanish included. Nobody had ever run it: no
ledger row, so the flows were still silent, so my live-data check found exactly
nothing and I read that as "no tooling exists". Its copy was also better,
built on rules the account already holds (never ask when to call back, never
quote the network's price estimate back at a seller). I reverted mine, deleted
it, ran theirs.

**Why:** I read enough of the target to make my change compile, not
enough to learn what it already offers. Two of these (`emailCta`, and a
private copy of the unit conversion in a React component) were
duplicates of something that already existed a few lines away.

**How to apply:** before building anything on this repo, grep
`scripts/oneshot/` and `debug/` for the NOUN of the task ("voicemail",
"owner", "residency") before writing a script that does it. The ledger answers
"has it run", which is a different question from "does it exist", and only the
first is visible in tenant data. Then, before wiring into a shared helper, read
its full input type and at least one existing caller, and ask "does this already
have a general answer to what I am about to special-case?" When the
answer is a key name, a slot, or an enum the other side reads, grep for
where it is *consumed*, not just where it is declared. Prefer adopting
the general mechanism over adding a narrower parallel one, even when the
narrow one is smaller to write.

Aug 10 2026 added a sharper variant: **a negative grep is not proof the
thing does not exist.** Asked to sign the HQ flow replies, I searched
`src/lib/` and `src/app/api/` for "signature", got only document-signing
and webhook-HMAC hits, concluded "no email signature concept exists", and
hand-wrote a constant. There were THREE definitions: the plain-text one
in `assembleBody` (outreach, built from `outreach_settings.sender_name`),
the branded HTML block in `src/lib/email/branded-html.ts`, and the
canonical artwork in `docs/email-signatures.html`. Mine invented an
address line the real one has never had, and dropped the logo, the title
and the phone number. Brian had to tell me twice.

What would have found it: searching the whole repo rather than two
directories, including `docs/`; searching for the CONTENT (a phone
number, "Founder") rather than only the concept word; and treating "I am
about to hard-code a company fact" as the trigger to look harder, since
those facts are almost always already stored somewhere.

Related: [[feedback_testing]] catches logic errors; it does not catch
these, because a wrong key still typechecks and still passes a test that
asserts on the same wrong key.
