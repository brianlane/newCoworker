---
name: zapier-publish-state
description: "Zapier app 243681 is APPROVED and publicly listed as of Aug 5 2026, in the 90-day Beta; zapier-platform history is the authority on version state"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3f3013a9-daa6-4161-b54f-dd1fb7be19bd
  modified: 2026-08-05T07:00:58.689Z
---

New Coworker's Zapier integration (app 243681) was **approved into the public
App Directory on 2026-08-05**, after one round of review feedback. The listing
is live at https://zapier.com/apps/new-coworker/integrations and the invite link
is no longer needed to connect. [[zapier-invite-url-retired]] covers the code
side.

It sits in Zapier's **90 day Beta**, then enters the Partner Program
automatically. Zapier can revert an app to Private during Beta if it draws heavy
support volume. Future version changes follow promote > migrate > deprecate and
do **not** need another full technical review.

**Check version state authoritatively** (the binary is `zapier-platform`, not
`zapier`):

```bash
cd zapier && ./node_modules/.bin/zapier-platform history
```

That history is the only trustworthy source. During submission a
`zapier promote` printed what looked like success but the platform logged
`deployment blocked`; an app in review cannot self-promote, and the version goes
to production when Zapier approves.

Review lesson worth keeping: the reviewer's blocker was a **real product bug**,
not a test-account quirk. Our settings form never passed `current_password` to
Supabase's password update, so no customer could change their password (fixed in
#1166). Treat reviewer findings as production signals.

Keys: `nck_7371505f` ("Zapier publish gates") is the key exposed in the Cursor
transcript archive and still drives five HQ Zaps; rotating it breaks their
connection until someone re-authenticates.

Related: [[fleet-redeploy-check]].
