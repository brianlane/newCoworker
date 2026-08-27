---
name: fleet-redeploy-check
description: "Read-only way to tell whether tenant VPS boxes actually run current main, instead of guessing from PR dates"
metadata: 
  node_type: memory
  type: project
  originSessionId: 362dcc28-eb3a-4e93-bea8-1bd62ac9eec4
  modified: 2026-08-03T18:16:49.286Z
---

A merged `vps/` change is not live until the fleet redeploys, and the tracker
notes about "the fleet is behind on PR X" go stale fast. Check the boxes
directly instead of reasoning from merge dates:

```bash
tsx debug/vps-exec.ts <businessId> "cd /opt/newcoworker-repo && git log --oneline -1"
```

`/opt/newcoworker-repo` HEAD is the main commit the box was last deployed from,
so **everything merged at or before that commit is live and everything after is
not**. Confirm a specific change with a grep for one of its new identifiers in
the deployed tree, for example
`grep -c translatorTierAllowed /opt/voice-bridge/src/index.ts`.

`vps-exec.ts` runs as root on a live box, so keep the command read-only.

Pick the right redeploy script per subtree, because they are not
interchangeable: `vps/voice-bridge` needs
`tsx debug/redeploy-voice-bridge.ts --all` (`--dry-run` first; it skips tenants
mid-call), `vps/chat-worker` needs `tsx debug/update-all-vps.ts`, and
`vps/scripts/deploy-client.sh` changes need nothing because they only affect
future deploys. Scope the work with
`git log --oneline <boxHead>..HEAD -- vps/` before touching anything.

On 2026-08-03 all boxes sat at #1062 while `main` was at #1136, but only three
`vps/` commits were actually missing, so the honest gap was far smaller than the
PR-number distance suggested.

Related: [[zapier-publish-state]].
