-- Business Documents knowledge library (BizBlasts-inspired).
--
-- Owners upload real business documents (price sheets, service menus,
-- cancellation policies, FAQs, SOPs). The platform extracts/condenses each
-- into agent-readable markdown (`content_md`) that grounds
-- business_knowledge_lookup and the on-VPS vault digest, with an audience
-- gate so customer channels only ever see client-safe content.
--
-- Security posture: RLS on with NO policies on both tables — service-role
-- only, identical to vps_ssh_keys / customer_profiles. Every access goes
-- through the Next.js server (owner-authenticated dashboard routes, tool
-- adapters, the tokenized public download route) after its own auth checks.

create table if not exists business_documents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  title text not null,
  category text not null default 'general',
  -- 'clients' | 'staff' | 'both': which coworker surfaces may use the doc.
  -- Customer channels (voice/sms/webchat/flows) require 'clients' or 'both';
  -- 'staff' docs are dashboard-only and can never leak to a caller.
  audience text not null default 'both'
    check (audience in ('clients', 'staff', 'both')),
  -- Original file in the private `business-docs` storage bucket
  -- (`<businessId>/<docId>/<filename>`).
  storage_path text not null,
  mime_type text not null,
  byte_size bigint not null default 0,
  -- Agent-facing extracted/condensed markdown. Edits from the dashboard or
  -- the document_update tool patch THIS, never the original file.
  content_md text not null default '',
  -- 1-2 sentence description used for retrieval selection + compile-time
  -- document binding in AiFlow generation.
  summary text not null default '',
  status text not null default 'processing'
    check (status in ('processing', 'ready', 'failed')),
  error_detail text,
  -- Expiration: past this instant the doc is excluded from knowledge
  -- lookups, the vault digest, and sharing. NULL = never expires.
  expires_at timestamptz,
  -- One-reminder-per-state flags for the daily expiration sweep (armed /
  -- cleared like low_balance_alert_armed). Reset when expires_at changes.
  expiring_soon_notified_at timestamptz,
  expired_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_business_documents_business
  on business_documents (business_id, created_at desc);

alter table business_documents enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated denied by design.

-- Tokenized, revocable share links. The URL carries the capability; we store
-- only its sha256 (O(1) lookup, a DB dump alone cannot reconstruct live
-- links).
create table if not exists business_document_shares (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  document_id uuid not null references business_documents(id) on delete cascade,
  token_sha256 text not null,
  -- Who the link was sent to (phone / email / free label) — PII, scrubbed by
  -- the privacy erasure path.
  shared_with text not null default '',
  -- Surface that minted the link: dashboard | sms | voice | webchat | flow.
  channel text not null default 'dashboard',
  expires_at timestamptz not null,
  revoked_at timestamptz,
  access_count integer not null default 0,
  last_accessed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_business_document_shares_token
  on business_document_shares (token_sha256);

create index if not exists idx_business_document_shares_document
  on business_document_shares (document_id, created_at desc);

create index if not exists idx_business_document_shares_business
  on business_document_shares (business_id, created_at desc);

alter table business_document_shares enable row level security;
-- No policies: service_role only, same posture as business_documents.

-- Private bucket for the original uploads. Only the service role reads or
-- writes it (owner dashboard proxies + the tokenized download route); no
-- storage.objects policies, same posture as generated-images.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'business-docs',
  'business-docs',
  false,
  10485760, -- 10 MB per file
  array['application/pdf', 'text/plain', 'text/markdown', 'text/csv']
)
on conflict (id) do nothing;
