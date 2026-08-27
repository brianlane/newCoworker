# New Coworker agent instructions

Cursor loads these automatically:

- [`.cursor/rules/`](.cursor/rules/) always-on working agreements, plus globbed migration rules
- [`.cursor/skills/`](.cursor/skills/) (`e2e-bug-hunt`, `dependabot-triage`, `oneshot-patch`)
- [`.cursor/hooks.json`](.cursor/hooks.json) session start copies the context pack
- [`.cursor/memory/MEMORY.md`](.cursor/memory/MEMORY.md) project memories; open the linked file when the task matches

The README carries the long form of the same contracts under "Start every session from the context pack", "All work and code modifications must follow this flow", and "Writing a migration". Nested migration spec: [supabase/migrations/CLAUDE.md](supabase/migrations/CLAUDE.md).
