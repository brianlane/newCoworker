---
name: signed-in-smoke-recipe
description: TEST_USERNAME/TEST_PASSWORD in .env are stale; how to verify signed-in behavior locally instead
metadata: 
  node_type: memory
  type: project
  originSessionId: dfe1f005-171e-4253-aa14-792794fe8df8
  modified: 2026-08-01T20:16:39.300Z
---

The `.env` TEST_USERNAME (brianlanefanmail@gmail.com) / TEST_PASSWORD credentials fail with invalid_credentials as of 2026-08-01 (the 9-char password predates the 12-char minimum from PR #1103). Nothing in the repo references them.

Working recipe for signed-in local verification (used for PR #1113):
1. Create a throwaway user with the service role, same pattern as `debug/*-reviewer-setup.ts`: `admin.createUser({ email: "nc-smoke-<epoch>@example.com", password: <random>, email_confirm: true })`. There are no triggers on `auth.users`, so it creates no app rows; `admin.deleteUser(id)` afterward leaves nothing behind.
2. Sign in via `POST {SUPABASE_URL}/auth/v1/token?grant_type=password`, then build the app's exact cookie format by feeding the tokens to `@supabase/ssr` `createServerClient` with a stub cookie jar and `auth.setSession(...)`.
3. Assert server behavior with authenticated curl (redirect statuses, SSR HTML of client components like the dashboard sidebar). Injecting the session cookie into the Claude browser pane via javascript_tool is blocked by the permission classifier, so client-only hydration behavior cannot be watched live; verify it by pattern match against `src/app/reset-password/page.tsx`'s getSession tri-state instead.

Also needed in a worktree: symlink `node_modules`, `.env`, and `.env.local` from the main checkout, and revert the `next-env.d.ts` churn the dev server writes before committing.
