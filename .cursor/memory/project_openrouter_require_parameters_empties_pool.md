---
name: project_openrouter_require_parameters_empties_pool
description: "OpenRouter's require_parameters:true returns zero endpoints on our onboarding models, because temperature and max_completion_tokens are undeclared yet still honored"
metadata: 
  node_type: memory
  type: project
  originSessionId: e4574601-c302-4297-a49a-7dd0e9c2fae0
  modified: 2026-08-19T04:20:50.761Z
---

`provider: { require_parameters: true }` on OpenRouter reads like the obvious
companion to a structured-output request ("only route to endpoints that support
everything I sent"). On our onboarding models it returns **404 No endpoints
found** and would take the signup form down.

Two independent causes, both verified live in Aug 2026:

- **No OpenAI GPT-5.x endpoint declares `temperature`.** Reasoning models do not
  accept it, so `gpt-5.4-nano` and `gpt-5.6-luna` list `max_tokens`/
  `max_completion_tokens`, `reasoning`, `response_format`, `structured_outputs`,
  `seed`, `tools`, `tool_choice` and nothing else.
- **Zero DeepSeek endpoints declare `max_completion_tokens`.** They declare
  `max_tokens`.

The trap is that both parameters **are still honored**. OpenRouter normalizes
them to the upstream: a request with `max_completion_tokens: 20` comes back with
exactly `completion_tokens: 20` and `finish_reason: "length"` on
`deepseek-v4-flash-0731`, `deepseek-v4-flash` and `gpt-5.4-nano` alike. So
`supported_parameters` is a **routing declaration list**, not a capability list,
and `require_parameters` filters on the declaration while the normalization layer
would have handled the call fine.

What works instead, and what [[project_onboarding_intake_model_topology]] now
ships: `provider: { data_collection: "deny", zdr: true }` with no
`require_parameters`. Verified 12/12 strict-schema calls pass across the
surviving pool, and it excludes the Chinese endpoints (Baidu, SiliconFlow) that
unconstrained routing was reaching.

**How to apply:** before adding any `provider` constraint, probe it with a real
call rather than reasoning from the endpoints API. `curl` the model's
`/api/v1/models/<slug>/endpoints` to see what is declared, then actually POST
with the constraint and confirm you get a completion and not a 404. A
constraint that empties the pool fails closed at request time, which on the
pre-signup intake route means no new customers.
