---
name: gemini-model-eval
description: Weekly Gemini model discovery and adopt/skip rules
metadata:
  type: project
---

## project-gemini-model-eval

Do not start from a model name. `npx tsx debug/gemini-model-eval.ts` lists
Google's models and diffs `src/lib/gemini-model-pins.ts`. If a new Flash is
on the API and newer than a pin, it appears. Passing `--model gemini-X.Y-flash`
is how the last session almost missed the point.

Adopt rules (already paid for):

- generateContent must 200. A 404 id as a default killed inline chat
  (`gemini-3.1-flash`, PR #655).
- SMS / owner / voice_task also need OpenAI-compat (llm-router).
- Meter post-intro list price, never the launch promo (3.7-flash intro
  lapses 2026-12-31).
- Flagship Flash does not replace the SMS/lite pin (3.5-flash was a poor
  deal on that path).
- Preview / cyber / `-latest` never become fleet defaults.
- Live audio pins are never auto-adopted.
- `thinkingLevel: "minimal"` 400 is not a skip (PR #1372 retries to low).

Weekly Action: `.github/workflows/gemini-model-eval.yml`. Skill:
`.cursor/skills/gemini-model-eval/SKILL.md`. Changing a code default is
still not a fleet rollout: see [[project-gemini-model-env-pin-layers]].
