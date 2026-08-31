---
name: fleet-redeploy-check
description: "Read-only way to tell whether tenant VPS boxes actually run current main, instead of guessing from PR dates"
metadata: 
  node_type: memory
  type: project
  originSessionId: 362dcc28-eb3a-4e93-bea8-1bd62ac9eec4
  modified: 2026-08-28T17:35:12.613Z
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

## The boxes drift apart, so redeploy the WHOLE fleet, then verify each one

2026-08-28: after rolling one tenant, the other four were still on two
different old commits (`8701c5f` and `a9badee`) with no copy of the change.
Per-box HEADs diverge, so "the fleet is on X" is never a single answer. Roll
every box and re-read every HEAD afterwards.

## `scripts/redeploy-voice-bridge.ts` does NOT load `.env` itself

It reads `process.env` and exits early (code 2) with a bare
`missing NEXT_PUBLIC_SUPABASE_URL` / `missing HOSTINGER_API_TOKEN`. The caller
must pre-load:

```bash
set -a && source .env && set +a
```

Two traps around that, both hit on 2026-08-28:

- Shell state does NOT persist between tool calls, so the `source` has to be in
  the SAME command as the redeploy. A loop that forgot it "succeeded" on four
  boxes that were never touched.
- Do not judge the result from filtered output. `... | grep -E ...` swallows the
  `missing ...` line, and a following bare `$?` reads the grep/echo, not the
  script (see [[pipe-exit-code-masks-failures]]). Log to a file, then verify
  against the box.

Sourcing `.env` prints `line 59: Coworker: command not found`
(`MICROSOFT_PUBLISHER_NAME=New Coworker` is unquoted). It is NOISE: sourcing
continues and every later var, `HOSTINGER_API_TOKEN` at line 135 included,
loads fine. Only `MICROSOFT_PUBLISHER_NAME` ends up empty. Measuring it with
`source .env | head` will show vars missing, but that is the pipe running
`source` in a subshell, not a truncated load.

`sshExec` takes `{host, port, username: key.ssh_username, privateKeyPem:
key.private_key_pem, command, timeoutMs}`. Wrong field names fail with
`Invalid username`, and `resolveTenantVpsPublicIp(vpsId, token, logPrefix)`
needs the token passed explicitly or every box reports `401 Unauthenticated`.

Related: [[zapier-publish-state]], [[pipe-exit-code-masks-failures]].
