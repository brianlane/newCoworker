---
name: browser-pane-vs-real-chrome-for-console-work
description: "In-app Browser pane: hidden pane means 0x0 viewport where real input drops SILENTLY; resize_window desyncs clicks; drive third-party consoles with synthetic DOM events verified server-side, hand off to real Chrome, or (for OUR OWN pages) script headless Chromium from the ms-playwright cache"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 14523852-41c5-4e84-a67a-f3e2fdce32aa
  modified: 2026-08-11T09:15:12.609Z
---

On 2026-07-31, an hour was lost driving marketplace.zoom.us in the in-app
Browser pane: after any `resize_window`, click injection desynced from the
page (clicks delivered at ~6.6x the intended coordinates). The failures
looked exactly like the app rejecting input, which led to a wrong "form is
locked during review" theory. Cursor, driving Brian's real Chrome, made the
same edits immediately.

On 2026-08-11 (Slack Marketplace submission), the deeper root cause showed:
when the pane is HIDDEN on the user's side, tabs run with `innerWidth =
innerHeight = 0`. In that state real `computer` clicks/scrolls drop silently
(tool reports success, page receives NOTHING, network shows no request),
screenshots render compositor garbage (content offset or blank), and
`resize_window` cannot help because there is no surface. An installed
`document.addEventListener('click', ...)` probe recording `e.clientX/Y` +
`isTrusted` is the fast way to prove delivery vs. silence.

**Why:** synthetic-input failures are indistinguishable from app-side
validation/locking from inside the page, so a broken pipeline poisons every
conclusion drawn on top of it.

**How to apply:** check `innerWidth` FIRST when pane interactions misbehave;
0 means stop trying real input. What still works in a 0x0 pane, in order of
preference: `form_input` by ref (inputs/textareas), `javascript_tool` with
native value setters + `input`/`change` events (Formik pages then need
`form.requestSubmit()`; some React buttons need their `__reactProps$`
`onClick` invoked; some components only accept values through their own
`onChange` prop), and reading state back after a HARD reload as the only
trustworthy save-verification. Slack's multi-select comboboxes are
contenteditable type-aheads: focus + `document.execCommand('insertText')`
opens the filtered list, then dispatch mousedown/mouseup/click on the
option; state updates land on the NEXT tick, so verify in a separate call.
Renderers degrade after heavy use: a fresh tab (tabs_create) resets. For
authenticated third-party consoles, `mcp__claude-in-chrome__*` (real Chrome)
or an early user handoff is still the least-pain path. Related:
[[bugbot-down-do-not-merge]].

**Screenshotting our own localhost pages: skip the pane entirely.** On
2026-08-18 (pricing redesign) the same 0x0 pane produced screenshots with
the content offset into the bottom fifth of a blank canvas, which made
layout review impossible. `playwright-core` installed into the SCRATCHPAD
(never the repo) drives the already-present global browser cache:

    npm i playwright-core@1.56.0     # in the scratchpad, not the repo
    executablePath: ~/Library/Caches/ms-playwright/      chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/      chrome-headless-shell

The repo has no playwright dependency, but `~/Library/Caches/ms-playwright`
is already populated, so nothing downloads. Two gotchas: `waitUntil:
"networkidle"` NEVER settles against `next dev` (HMR socket), so use
`domcontentloaded` plus a fixed wait; and `next dev` rewrites
`next-env.d.ts` to point at `.next/dev/types`, so `git checkout --
next-env.d.ts` before committing.

This buys `deviceScaleFactor: 2`, element-clipped shots, per-locale cookies,
and, most valuable, ASSERTIONS: reading `getBoundingClientRect().top` for
each card's CTA caught a 2px button misalignment and a Spanish string
truncation that eyeballing screenshots missed.
