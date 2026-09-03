---
name: gemini-model-eval
description: >-
  Check Google's Gemini API for model ids newer than our worker pins and
  decide whether to adopt them. Use when a new Gemini Flash ships, when
  asked whether to bump SMS_CHAT_MODEL / GEMINI_ROWBOAT_MODEL / dashboard
  chat, or when the weekly gemini-model-eval workflow opens an issue.
---

# Gemini model eval

Do not start from a model name. Google's `models.list` is the input. If a
new Flash is on the API and newer than a pin, this procedure finds it. If
you already know the id (someone said "3.8 Flash"), still run the script
with no `--model` flag: either the list contains it, or it is not actually
available on our key.

## Why this exists

Which Gemini each worker uses used to live in a dozen files, and "should we
take the new Flash?" was re-derived every launch. The wrong answers we
already paid for:

- `gemini-3.1-flash` 404'd. A default that does not exist on
  `:generateContent` breaks the surface (PR #655).
- SMS and `voice_task` reach Gemini through the llm-router's OpenAI-compat
  path. Native generateContent succeeding is not enough for those pins.
- Launch promo prices lapse. 3.7-flash intro was $0.75/$3.75 through
  2026-12-31; we meter the post-intro $1.50/$7.50 so the fuse does not
  undercount the day the promo ends.
- A pricier flagship on the SMS/lite pin is a bad deal (3.5-flash at
  ~$0.026/turn vs ~$0.004). Family mismatch is a skip, not a maybe.
- Preview / cyber / `-latest` ids are never fleet defaults.
  `gemini-3.5-live-translate-preview` satisfied "must contain live" and was
  the wrong product.
- `thinkingLevel: "minimal"` 400s on some Flash ids (3.7). That is not a
  skip: `geminiGenerateTextDetailed` already retries at `low` (PR #1372).

The map of workers to defaults is `src/lib/gemini-model-pins.ts`. Edit the
pin when you bump a default, not a comment in deploy-client.sh alone.

## Run

```bash
npx tsx debug/gemini-model-eval.ts
```

Needs `GOOGLE_API_KEY` (the `internal-ci-debug` key, never the tenant
key). See `docs/GEMINI-SPEND.md`.

The script:

1. Lists every `gemini-*` id on the key (`models.list`, paginated).
2. Diffs that list against `GEMINI_MODEL_PINS` (`findNewerCandidates`).
3. Probes each newer GA id: `:generateContent`, OpenAI-compat,
   `thinkingLevel` minimal and low.
4. Resolves a post-intro list price: our meter table, else Google's
   pricing page (intro rates that undercut the current pin are ignored),
   else the newest older same-family pin.
5. Prints adopt / wait / skip / already per worker.

Exit 0: nothing newer. Exit 2: at least one adopt or wait. Exit 1: crash
or missing key.

`--json` prints the report as JSON. `--out <path>` writes it to a file.

The weekly GitHub Action `.github/workflows/gemini-model-eval.yml` runs
this on Mondays and on `workflow_dispatch`. It opens one issue per
candidate that scored adopt or wait.

## Cursor Automation prompt

Paste this as the automation body (weekly is enough):

```
Follow `.cursor/skills/gemini-model-eval/SKILL.md`.

Run `npx tsx debug/gemini-model-eval.ts` with no model argument. Google's
models.list is the only source of candidates. Report which workers would
adopt, wait, or skip. Do not bump fleet defaults in that same run unless
the verdict is adopt, both generateContent and OpenAI-compat succeeded
where the pin needs them, and the post-intro price is at or below the
current pin. If you do bump, add the model to both price tables first
(src/lib/billing/ai-spend-meter.ts and
supabase/functions/_shared/chat_spend_cap.ts) at the post-intro rate, never
the launch promo. Changing a code default is not a fleet rollout:
GEMINI_ROWBOAT_MODEL is also forwarded from the laptop .env and Vercel.
```

## After an adopt

1. Add the id to both `GEMINI_PRICES_PER_1M` tables at the post-intro rate.
2. Change the pin's `defaultModel` and every `mustContain` source the
   lockstep test names.
3. Advertise the id on the llm-router `/v1/models` list if a Rowboat pin
   moved.
4. Do not stop at the script default. Verify on-box
   (`grep '^GEMINI_ROWBOAT_MODEL=' /opt/rowboat/.env`) and remember Vercel
   env can pin an older id on new provisions.
