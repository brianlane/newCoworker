-- HIPAA audit controls, 45 CFR 164.312(b): a record of WHO looked at tenant
-- customer content, so "who accessed this patient's record" is a query rather
-- than an investigation.
--
-- We already log admin ACTIONS (src/lib/admin/audit.ts into system_logs) but
-- never reads, which is the half an auditor actually asks about. This table
-- covers human dashboard reads for tenants with businesses.hipaa_mode on;
-- background/AI context reads are deliberately out of scope (see
-- src/lib/hipaa/access-log.ts for that reasoning).
--
-- APPEND-ONLY BY GRANT. service_role gets select + insert and deliberately NOT
-- update or delete, so the trail cannot be rewritten or trimmed even with the
-- service key. That also means no retention sweep can touch it, which is the
-- behavior 164.316(b)(2) wants: retain for six years. Deleting a business does
-- NOT cascade here for the same reason (no FK), so the trail outlives the
-- tenant row it describes.
--
-- NOTE: this table itself contains PHI, because identifying the record that
-- was viewed is the whole point (resource_id is typically a patient phone
-- number). It is service-role only with RLS on and zero policies; browsers
-- never touch it.

create table if not exists public.phi_access_log (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  -- The acting workforce member. Denormalized email because the auth user may
  -- be deleted later and the trail must still name who it was.
  user_id uuid,
  user_email text,
  -- What they did and to what. `resource` is a logical surface
  -- ('contact', 'sms_thread', 'voice_transcript', 'email_thread'), not a table
  -- name, so the trail survives schema churn.
  action text not null,
  resource text not null,
  resource_id text,
  -- Evidence fields, same shape as terms_acceptances.
  ip text,
  user_agent text,
  accessed_at timestamptz not null default now()
);

alter table public.phi_access_log enable row level security;

-- Review by tenant and time: "show me every access for this business".
create index if not exists idx_phi_access_log_business
  on public.phi_access_log (business_id, accessed_at desc);
-- The auditor's question: "who opened this patient's record?"
create index if not exists idx_phi_access_log_resource
  on public.phi_access_log (resource, resource_id, accessed_at desc);

comment on table public.phi_access_log is
  'HIPAA 164.312(b) audit controls: human dashboard reads of tenant customer content for hipaa_mode tenants. Append-only by grant (no update/delete), retained 6 years per 164.316(b)(2), never swept. Contains PHI; service-role only.';

-- Append-only: select + insert ONLY. Adding update or delete here would defeat
-- the point of the table.
grant select, insert on table public.phi_access_log to service_role;
