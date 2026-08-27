---
name: always-babysit-never-ask
description: Babysit every PR to green and merge without asking; do not offer to hand a PR back for review
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e000a484-971a-41d7-89ce-7300b68c7bdb
  modified: 2026-08-17T22:24:20.453Z
---

Never ask whether to babysit a PR. Always carry it: CI and Bugbot to green,
every review thread resolved, squash merge, watch the push-to-main run, remove
the worktree.

This includes PRs that correct my own earlier mistakes. I asked whether Brian
wanted to review a correction-to-my-own-claims PR himself instead of me merging
it, and the answer was "Always babysit".

**Why:** the repo's flow already says a change is not shipped until main is
green and the worktree is gone. Asking mid-flow stalls the work and pushes a
decision that was already made onto Brian.

**How to apply:** finish the whole flow silently and report the outcome. The
only reasons to stop are the ones that genuinely block: a required check that
cannot pass, an unresolved Bugbot finding I disagree with, Bugbot down
([[never-merge-while-bugbot-is-down]]), or a change that needs a decision only
Brian can make.

Related: [[pr-checks-appear-in-waves]], [[main-run-watch-trap]].
