# New Coworker agent instructions

Cursor loads these automatically. Claude Code loads the same rule files
through `@` imports in `CLAUDE.md`.

- [`.cursor/rules/`](.cursor/rules/) always-on working agreements, plus globbed migration rules
- [`.cursor/skills/`](.cursor/skills/) (`e2e-bug-hunt`, `dependabot-triage`, `oneshot-patch`, `gemini-model-eval`)
- [`.cursor/hooks.json`](.cursor/hooks.json) session start copies the context pack
- [`.cursor/memory/MEMORY.md`](.cursor/memory/MEMORY.md) project memories; open the linked file when the task matches

The README carries the long form of the same contracts under "Start every session from the context pack", "All work and code modifications must follow this flow", and "Writing a migration". Agent-facing migration rules: [`.cursor/rules/migration-timestamps.mdc`](.cursor/rules/migration-timestamps.mdc) and [`.cursor/rules/migration-grants.mdc`](.cursor/rules/migration-grants.mdc). Claude Code imports those two from [supabase/migrations/CLAUDE.md](supabase/migrations/CLAUDE.md).
