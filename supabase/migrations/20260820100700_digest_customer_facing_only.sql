-- Per-tenant digest gate: when true, the daily/weekly digest email is sent
-- only if the window contained CUSTOMER-FACING activity (customer texts,
-- calls, new customers, urgent alerts). Background AiFlow runs, dashboard
-- chat turns, owner-directed sends, and delivered-notification counts no
-- longer trigger an email on their own (they still render in the body when
-- a digest does send). Default false = existing behavior for every tenant.
-- First enabled for the HQ tenant, whose "Team inbox triage (HQ)" flow was
-- producing a daily "5 runs, done" email with nothing actionable in it.

alter table public.notification_preferences
  add column if not exists digest_customer_facing_only boolean not null default false;

comment on column public.notification_preferences.digest_customer_facing_only is
  'When true, digest emails send only for windows with customer-facing activity (customer texts, calls, new customers, urgent alerts); routine-only windows are skipped with reason no_customer_facing_activity.';
