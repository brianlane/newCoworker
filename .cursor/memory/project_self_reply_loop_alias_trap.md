---
name: project_self_reply_loop_alias_trap
description: "Our own outbound mail arrives as INBOUND via the catch-all, and every address source returns the account not the send-as alias, so any self-check by address set is broken"
metadata: 
  node_type: memory
  type: project
  originSessionId: 40416682-0de3-4391-a713-4b717801572b
  modified: 2026-08-07T18:20:48.863Z
---

Aug 7 2026. The HQ triage flow replied-all, which cc'd
`team@newcoworker.com`. Cloudflare's catch-all forwards that into the connected
Gmail mailbox, so **our own reply arrived as genuinely RECEIVED mail**, matched
the flow again, and drafted another answer. Six rounds.

Two independent pollers had the same hole, and both had a self-check that
could never fire:

| Poller | Self-check it had | Why it missed |
| --- | --- | --- |
| `src/lib/ai-flows/email-poll.ts` | `provider_account_email` | returns `newcoworkerteam@gmail.com` |
| `src/lib/email-coworker/poll.ts` | Gmail `/profile` + `businesses.owner_email` | both return `newcoworkerteam@gmail.com` |

**The trap:** HQ signs in as one Google account and *corresponds from a send-as
alias* on the tenant domain. Every address source we own reports the ACCOUNT.
Nothing in our data model knows the alias list, so an address-set check is
structurally incapable of catching a self-send. `in:inbox` does not help either:
a self-addressed message really is delivered to the inbox. (The Microsoft
fetchers use `mailFolders/inbox` with a comment about never triggering on the
owner's sent mail; that reasoning is about the Sent folder and does not cover
this at all.)

**The fix, and why it needs both halves:**

- **`-from:me` on the Gmail list query.** Gmail resolves `me` to the account
  AND every configured send-as alias, which is exactly the set we cannot
  enumerate. This is the only complete guard. Verified on the live HQ mailbox
  before shipping: the raw query returned 8 messages, 7 of them our own
  `Brian <team@newcoworker.com>` copies, and `-from:me` dropped exactly those
  while keeping the real lead.
- **Anything on `tenantEmailDomain()` is ours.** Provider-agnostic, so Outlook
  is covered, where the query has no equivalent. Match the domain exactly
  (`from.slice(lastIndexOf("@") + 1) === domain`), never a suffix: a suffix
  test treats `someone@newcoworker.com.evil.test` as ours.

Also exclude the tenant domain from reply-all cc
(`api/aiflows/send-owner-email`) so the self-copy is never generated, not
merely filtered afterwards.

**Before adding any new mailbox poller or auto-responder, apply both.** The
sources are `connectionEmail()` / `fetchMailboxAddress()` and they will keep
looking correct while being useless for this.

Related: [[project_email_routing_catchall_is_the_product]] is why the catch-all
exists and must not be repointed; this memory is the consequence nobody had
traced. [[feedback_assert_the_producer_not_the_fixture]] applies to testing it:
drive the real fetcher and read the endpoint it sent, because a test that
builds the query string itself passes with the guard removed.
