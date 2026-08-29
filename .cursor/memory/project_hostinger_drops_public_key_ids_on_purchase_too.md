---
name: project-hostinger-drops-public-key-ids-on-purchase-too
description: Hostinger drops setup.public_key_ids on the PURCHASE path as well, not just setup/recreate/attach; the PIS-embedded authorized_keys write is the only deterministic attach, and the purchase path lacked it plus the post-install quiescence wait
metadata:
  type: project
---

`setup.public_key_ids` is **not** a key-attach mechanism on any Hostinger
endpoint, purchase included. Embedding the key in the post-install script as
an `authorized_keys` write is the only deterministic attach.

#359 established this for the standalone setup/recreate/attach endpoints and
fixed the ADOPT path. `provision.ts` then documented the opposite for the
purchase path ("the purchase-embedded setup path still honors
`public_key_ids`"). That claim was never true, only never tested.

**Proof, Scar Fairy 2026-08-29.** The term-renewal sweep bought VM 1939337
with `public_key_ids: [568047]`. Hostinger returned success, the box came up
`running` on the right template, actions showed only `ct_create` +
`ct_install_monarx`, and the key was never in root's `authorized_keys`
(verified by hand 5.5h later, so not a cloud-init race). The provision died at
17% on `All configured authentication methods failed` holding a paid box.
Fixed in [#1740](https://github.com/brianlane/newCoworker/pull/1740).

**Why it hid for months.** Until [[project-hostinger-purchase-response-shape]]
was fixed (#1696, 2026-08-28), every purchase threw on the reply parse, so
every box the fleet owned arrived through the adopt/reconcile path, which
embeds the key. VM 1939337 was the FIRST clean purchase in the fleet's history
and the first to depend on `public_key_ids`. It failed on first contact.
Expect this shape again: fixing a gate that never opened exposes whatever was
behind it, untested.

**The purchase path was missing TWO things adopt has.** When touching either
path, diff them:

1. **Key embedded in the PIS.** The blocker was structural: `orchestrate.ts`
   built the script string BEFORE `provisionVpsForBusiness`, which mints the
   keypair INSIDE. Hence `buildPostInstallScript`, a builder taking the public
   key. Any new caller must pass one.
2. **Post-install quiescence wait.** Hostinger runs an attached PIS through
   its OWN runner, not cloud-init, so `buildBootstrapSshCommand`'s
   `cloud-init status --wait` cannot see it. Measured: KIN VM 1936826 ran the
   loader 15:53:13 to 15:54:22 (69s); on the purchase path Hostinger reported
   VM 1939337 running 103s after create and the orchestrator SSHed in 1s
   later. Overlapping. `wait_for_apt` covers the apt half; nothing serialises
   two concurrent `bootstrap.sh` runs.

**The orchestrator's wait fails OPEN; adopt's fails CLOSED. Both are right.**
Adopt waits for an explicit `idle` because it runs from a debug script with 25
minutes and no route deadline. `waitForPostInstallQuiescence` waits only on an
explicit `busy`, because it sits inside the term-renewal sweep's 1800s budget,
where a probe answering something unexpected (empty stdout, no `pgrep` on a
minimal template) would burn 10 minutes and CAUSE a failure that would not
otherwise happen. See [[feedback-a-failing-old-test-is-evidence]]: the first
draft failed the pre-existing
`vps_bootstrapping/_bootstrapped messages reflect PIS attached` test, whose
generic executor returns neither word, and that test was correct.

**An auth rejection during that wait means the key is ARRIVING, not missing.**
The first draft returned immediately on auth failure, reasoning that the key
was not on the box and waiting could not put it there. True before this
change; false one commit later, because the PIS is now the thing that WRITES
the key. Early probes are legitimately rejected until that line runs, so
short-circuiting exited the wait exactly on the boxes depending on the PIS
write, which is to say exactly when Hostinger dropped `public_key_ids`. The
guard defeated itself precisely when it mattered. Bugbot caught it.

Auth rejections now keep the wait alive, bounded by `AUTH_GRACE_MS` (3 min)
from the first probe; past that with no successful authentication the key
really is not coming, and we hand back so the bootstrap raises the real error
inside its own 76s retry. Once any probe HAS authenticated, the key is
demonstrably there and only the overall deadline applies. General lesson: when
you add a mechanism that makes a condition transient, re-audit every guard
that treated that condition as permanent.

`isSshAuthFailure` is separate from `isSshConnectError` deliberately.
`isSshConnectError` matches the broad `"connection error:"` prefix that auth
failures ALSO carry, so a rejected key burns the bootstrap's full 6-attempt,
76-second retry budget. Retrying a refused port is right; retrying a rejected
key is not.

**`c8 ignore` on a production default hides an untested default.** The timer
defaults here are named module functions covered by a test that omits them
(`pollIntervalMs: 0` keeps it instant while routing through the real
`setTimeout` and `Date.now`). Note a no-op `sleep` is NOT enough to test these
paths: both budgets are wall-clock, so a give-up assertion needs a fake clock
or it spins against real minutes. Related: [[feedback-c8-ignore-fails-on-awaited-default]].
The same pattern hid this whole bug one level up: `defaultVpsProvisioner` sat
behind `c8 ignore ... tests inject vpsProvisioner`, so nothing ever asserted
what production sends. It is exported and asserted now. See
[[feedback-assert-the-producer-not-the-fixture]].

**Recovering a stranded paid box** is unchanged, see
[[project-hostinger-purchase-response-shape]]: `--adopt-vm <vmId>` buys
nothing and re-images with the key embedded, then
`scripts/oneshot/reconcile-migrated-vps-inventory.ts` writes the two
`vps_inventory` rows the adopt mode cannot ([[project-vps-inventory-write-traps]]).
