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
- `transcribe` / `translate` in the id are specialist Live SKUs, not the
  voice-bridge native-audio model (issue #1847).
- Live audio pins are never auto-adopted.
- `thinkingLevel: "minimal"` 400 is not a skip (PR #1372 retries to low).

Weekly Action: `.github/workflows/gemini-model-eval.yml`. Skill:
`.cursor/skills/gemini-model-eval/SKILL.md`. Changing a code default is
still not a fleet rollout: see [[project-gemini-model-env-pin-layers]].

Issue #1808 (2026-09-07) was a false positive. `recommendForPin` used to
wait on the Live audio pin before checking family, so every listed text
Flash opened the tracking issue. `findNewerCandidates` also treated
anything newer than webchat's 2.5-flash-lite as "newer than our pins"
(3.1-flash-lite, 3.5-flash, 3.6-flash), even though those ids are older
than the mid/flagship pins and cost more than webchat. Live wait is now
only for a live-family successor. Text ids that every matching pin would
skip on version or known-worse price are not candidates.

Flagship pins moved 3.7-flash to 3.8-flash in Sep 2026 (issue #1847).
The eval had scored adopt on 2026-09-03 (PR #1792) and every Monday
after; the bump itself is a separate change from the checker. SMS/lite
and webchat stayed put. `GEMINI_ROWBOAT_MODEL` on Vercel and the laptop
`.env` can still override the script default on new provisions and
redeploys.

The voice-bridge pin moved to `gemini-3.8-live` after issue #1879
(2026-09-21), off the preview id it had been using. That issue's
`generateContent` 400 is the Live API saying the id is WebSocket-only.
Google's pricing page lists the same Standard rates for both ids:
text $0.75/$4.50, audio $3/$12 per 1M ($0.005/min in, $0.018/min out).
`gemini-3.8-live-extended-thinking` is the same version and the wrong
product: it requires NON_BLOCKING tools, and the bridge stamps
`behavior: BLOCKING` on every declaration (`withBlockingToolBehavior`).
The enterprise voice slot rejects translate, transcribe, and
extended-thinking. A laptop or Vercel `GEMINI_LIVE_MODEL` still
overrides `deploy-client.sh` on redeploy, same trap as the Rowboat pin.
Proactive audio on 3.8 Live means the model may stay silent when speech
is not directed at it. The bridge still sends the greeting cue. Do not
set `proactiveAudio: false` (that 400s) or `thinkingConfig`.
