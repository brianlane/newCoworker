---
name: project-ollama-context-length-fleet-gap
description: "OLLAMA_CONTEXT_LENGTH was set only in bootstrap's kvm8 branch, so the whole kvm2 fleet silently truncated local-model prompts at 4096; fixed PR #1575"
metadata:
  node_type: memory
  type: project
---

`vps/scripts/bootstrap.sh` set `OLLAMA_CONTEXT_LENGTH=16384` in the **kvm8
branch only**. kvm2 and kvm4 got nothing, so they ran Ollama's 4096 default,
which TRUNCATES longer prompts rather than erroring. The `/v1`
OpenAI-compatible path the llm-router uses cannot pass `num_ctx` per
request, so the process env is the only lever.

The setting exists because of a diagnosed June 2026 incident on business
621a5b0d (Amy): preamble + agent instructions + owner preamble measure ~2.5k
tokens on their own, and `OwnerCoworkerLocal` also carries retained history
plus 3 RAG chunks, so past the ceiling the model "forgot" earlier turns.
Then PR #369 made kvm2 the Standard default in Jul 2026 and the fix never
followed the tier down. By Aug 2026 the whole fleet was kvm2, so **the fix
was live on zero boxes**.

Fixed in PR #1575: kvm2 pins 8192 (2 vCPUs, prefill is CPU-bound: ~2.7k
tokens measured at ~16s warm), kvm4 pins 16384.
`tests/vps-ollama-context-length.test.ts` fails when any Ollama-bearing
branch leaves it unset, via the shared parser `src/lib/vps/ollama-tuning.ts`.

**bootstrap.sh runs at PROVISION time only.** Editing it fixes new boxes and
nothing else. Existing boxes need `npx tsx debug/apply-ollama-context.ts
--all`, which reads the target value out of bootstrap.sh, rewrites the
systemd drop-in, restarts Ollama, and verifies via `/proc/<pid>/environ`.

**How to apply:** any bootstrap.sh change needs a matching fleet applier, or
it is a change to future boxes only. A box's live systemd drop-in can be
weeks behind the repo (Amy's still carried em dashes the repo had swept).
Related: [[project-fleet-redeploy-check]],
[[project-escalation-advisor-hardware-vs-usage]].
