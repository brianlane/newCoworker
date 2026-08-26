---
name: project_ok_true_is_not_a_commit
description: "inline-turn pins a turn on any ok:true from a SIDE_EFFECT_TOOLS name, which is wrong for any tool that can succeed without writing"
metadata:
  type: project
---

`src/lib/dashboard-chat/inline-turn.ts` marks a turn side-effect-pinned when a
tool in `SIDE_EFFECT_TOOLS` returns `ok: true`. Pinning does two things: it
suppresses the worker fallback, and it makes the degraded wrap-up emit
`sideEffectNote(...)`, an owner-facing sentence asserting the action happened.

**That equation breaks the moment a tool can succeed without committing.**
`edit_aiflow` now returns `ok: true` when it merely STAGES a change for
confirmation (and again when it returns blocking questions), both of which
write nothing. Left alone, a failed wrap-up told the owner "Automation X was
updated as requested" for a change that was only described back to them.

Fixed by `committedSideEffect(name, result)`: the applied write carries
`applied: true` and the pin keys on that for `edit_aiflow` specifically; every
other tool keeps the plain ok:true rule, since their success does imply a
write.

**Check this whenever you add a tool with a "staged" / "drafted" / "proposed"
success shape.** Bugbot caught it on the stacked PR, not the one that
introduced it, so the guard is not automatic.

Related: [[project_ai_flow_edit_hardening]].
