---
name: project_onboarding_intake_model_topology
description: "The intake form's primary is DeepSeek and gpt-nano is only the fallback; cost is a tenth of a cent per intake, and Luna is a DOWNGRADE with reasoning off"
metadata: 
  node_type: memory
  type: project
  originSessionId: e4574601-c302-4297-a49a-7dd0e9c2fae0
  modified: 2026-08-19T04:21:07.924Z
---

`src/app/api/onboard/chat/route.ts` (Step 2 of `/onboard/questionnaire`) is the
**only OpenRouter call site in the repo**. Everything else runs on Gemini. Three
things get misremembered about it:

**1. `gpt-5.4-nano` is the fallback, not the model doing the work.**
`resolveOnboardingModels()` returns `["deepseek/deepseek-v4-flash-0731",
"openai/gpt-5.4-nano"]` and the loop tries them in order. Nano runs only when
DeepSeek returns non-2xx, hits the 20s per-attempt timeout, or emits JSON that
fails parse or Zod. Asking "should we change the nano model" is asking about the
failure tail.

**2. Cost is not a lever here.** Measured live Aug 2026 against the real prompt
and schema: a DeepSeek turn is ~$0.0001 and a nano turn ~$0.0004, so a 10-turn
intake is **~$0.001 to ~$0.004**. Ten thousand signups a month is under $40.
OpenRouter's 5.5% credit fee is noise at that scale. Optimizing this spends more
engineering time than it can ever return.

**3. Swapping nano for `gpt-5.6-luna` is a REGRESSION as the route is written.**
Luna looks strictly better on paper (same $0.20 input, cheaper $1.20 output,
1.05M context vs 400K, newer cutoff, and it is the declared successor to the nano
tier). But the route sends `reasoning: { enabled: false }`, and every published
Artificial Analysis score is measured with reasoning **on**. With reasoning off
Luna scores **26.6** against nano's **38.2**. Luna only wins at medium effort
(39 vs nano's 40 at xhigh, at $0.17/1M vs $0.18/1M blended and a faster 2.94s
TTFT), and enabling reasoning collides with two existing constraints: reasoning
tokens count against `ONBOARDING_MAX_COMPLETION_TOKENS = 3000`, and Luna at low
effort runs ~145 tok/s so a 3000-token response is ~21s against a 20s
`OPENROUTER_ATTEMPT_TIMEOUT_MS`.

`gpt-5.4-nano` is **not deprecated**. OpenAI's official deprecations page lists no
GPT-5.4 retirement, contradicting secondary sources that claim one. Nothing is
forcing a migration.

Shipped in PR #1492 (Aug 19 2026): usage telemetry (the route previously read
nothing from `usage`, so effectiveness was unmeasurable), strict `json_schema`
replacing `json_object`, the provider lock from
[[project_openrouter_require_parameters_empties_pool]], and the primary pinned
from the bare slug (0423 build, AA index 40) to `-0731` (AA index 52).

**How to apply:** before arguing any model swap here, read the telemetry lines
(`[onboard/chat] openrouter turn served`) for how often attempt 2 fires. If the
fallback almost never runs, changing it is churn. And never carry a benchmark
number across a reasoning-effort boundary: see
[[feedback_prove_prompt_fixes_against_deployed]] for the same class of mistake.
