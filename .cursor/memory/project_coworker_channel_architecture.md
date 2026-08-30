---
name: project-coworker-channel-architecture
description: Adding an owner chat channel - the shared pipeline, the 12 widening sites, and the traps each channel hit
metadata:
  type: project
---

Slack, Telegram (#1722), Teams (#1723) and Google Chat (#1724) all run on one
pipeline. A fifth channel is mostly filling in a list, and the list is the
part that is easy to get wrong.

**Why:** the widening sites are NOT compiler-enforced. Only two are
(`CHANNEL_MAX_SILENCE_DAYS` and `OWNER_TURN_SURFACES`, both `Record`s over the
key union). Everything else is a string-literal array or a file outside
tsconfig, and a missed one fails silently.

**How to apply:**

*The shared spine, do not rebuild any of it:* `coworker_connections` /
`coworker_conversations` / `coworker_messages` / `coworker_jobs`;
`coworker-channels/worker.ts` (queue), `db/coworker-chat.ts` (store),
`owner-surfaces/run-turn.ts` (the turn), `coworker_channel_identities` +
link codes, `coworker-channels/tier-gate.ts`. The adapter seam is
deliberately two fields: `{ channel, runJob(job) }`.

*The widening sweep,* copy the Teams PR's file list: `CoworkerChannel`,
`NotificationDeliveryChannel`, `LIVENESS_CHANNELS` + silence days,
`OwnerSurfaceKey` + registry entry, `OwnerTurnSurfaceKey` + turn surface,
both `gatedChannels` arrays in `dispatch.ts`, `ResolvedTargets` + the leg,
`channel-liveness-read.ts` (the Promise.all AND the returned array),
`email_log` source (3 TS sites), prefs (row/defaults/keys/reSubscribed/
zod/`NOTIFICATION_TOGGLE_KEYS`/`CHANNEL_TOGGLE_KEYS`), integrations registry +
context + status + the `[slug]` page `case`, and the Deno mirror (union, prefs
SELECT string, `ResolvedTargets`, the leg).

*Every site in that sweep is INSIDE the product, and that is the blind spot.*
Telegram, Teams, Google Chat and push all shipped fully wired and completely
absent from the public site, because nothing in the checklist, and no test,
looks at marketing copy. #1749 caught up seven surfaces at once: the
`NATIVE_DEFS` grid on `/integrations` plus its `metaDescription` and
`ogDescription` (what search results quote), the plan bullet in
`buildStandardFeatures` AND its row in `comparison.ts` (`covers` fails CI only
in the bullet-without-a-row direction, never the reverse, so a shipped feature
sells itself nowhere and nothing complains), the Owner Notifications line on
`/features`, and the Privacy and Terms pages. Prices and legal text are the two
that actually cost something: four Standard-gated features nobody could see,
and collected data we had not disclosed. Both message catalogs, both locales.
Note push adds a genuinely new recipient class to Privacy that chat channels do
not, the relay service (Apple / Google / Mozilla), which sees a delivery
address and ciphertext and never the alert.

*Naming, when a row grows past one channel:* `rowSlack` became `rowTeamChat`
when its bullet grew to cover four. A key naming one channel while holding copy
about four is the same drift as [[feedback_verify_the_constant_not_the_comment]],
and it is cheap to fix at the moment the copy widens.

*The two unsubscribe payloads, which drifted for four channels:* "unsubscribe
from all" used to be hand-listed twice, in the dashboard button and in the
one-click link in our email footers. Push (#1717) and every chat channel
reached `NOTIFICATION_TOGGLE_KEYS` and the dashboard's toggle list but not the
email payload; the monthly recap (#1727) missed the dashboard button. Nothing
failed: `dispatch` suppresses on `unsubscribed_at` alone, so the only symptom
was the forgotten toggle rendering ON under the "you unsubscribed" banner.
#1738 collapsed both onto `CHANNEL_TOGGLE_KEYS`
(`src/lib/notifications/channel-toggles.ts`), which is `satisfies`-pinned to
real columns and test-pinned to `NOTIFICATION_TOGGLE_KEYS` minus the four
narrowing keys, so a new channel now reaches both surfaces or neither. The
`reSubscribed` list in `updateNotificationPreferences` is still hand-written,
but a test now drives every `CHANNEL_TOGGLE_KEYS` entry through it.

*Residency, the one that already bit us:* `notifications.delivery_channel`
AND `email_log.source` are mirrored in `vps/data-api/schema.sql` at TWO sites
each. A value the app emits but the box rejects stops that tenant's whole
write journal. Telegram shipped without this; Teams fixed it and added a
value-parity guard derived from the TS union. See
[[project_residency_read_rules]].

*The only guard on the Deno half* is `tests/notifications-deno-parity.test.ts`.
It is text comparison and it works: dropping a union member or a prefs-select
column each fails it.

*Traps each channel actually hit:*
- Teams: the sender's address is NOT on the activity, it needs a Bot
  Connector members fetch. Reading `entities` returns undefined forever and
  silently treats every colleague as a stranger.
- Teams: cannot START a conversation, so it needs a captured conversation
  reference and has a real connected-but-undeliverable state. Google Chat
  does not; the space IS the connection.
- Google Chat: a space name is opaque and shown nowhere in the UI, so the
  connect code binds the SPACE as well as the person. Refuse to move an
  already-bound business, and never throw after the code is spent (a 500
  makes Google retry into "that code is invalid", a dead end).
- Google Chat: a space holds many threads, so `thread_key` is the
  conversation and the space is only the place.
- Any recorded address is a CACHE, not the truth. Freezing it locks out
  anybody whose directory address changes. See
  [[feedback_verify_the_column_is_written]].

*Inbound auth for a JWT channel* is shared in `lib/webhook-auth/jwks.ts`:
pinned RS256, issuer, audience, expiry, one forced key refresh per 5 min on
an unknown kid, and a failed refresh reports `jwks_unavailable` (500, the
provider redelivers) not `unknown_key` (401, the message is LOST).
