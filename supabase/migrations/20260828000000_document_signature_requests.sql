-- Document e-signatures (BizBlasts client-document signing port).
--
-- The owner (or their dashboard coworker) sends a business document for a
-- DocuSign-style legal sign-off: the recipient opens a tokenized link,
-- reads the document, and signs by typing their legal name with an explicit
-- consent checkbox. The row records the full audit trail — who, when, from
-- which IP/UA, and a sha256 fingerprint of the exact content_md that was on
-- screen — so a signed request is standalone legal evidence even if the
-- document is edited later.
--
-- Lifecycle: sent → viewed (first open) → signed; the owner can void any
-- unsigned request. Same fail-closed token posture as
-- business_document_shares: the URL carries the capability, the DB stores
-- only its sha256.
--
-- Security posture: RLS on with NO policies — service-role only, identical
-- to business_documents / business_document_shares.

-- Deletion semantics: the document fk cascades so that deleting a business
-- (account-level erasure) sweeps everything, but the application refuses to
-- delete a DOCUMENT that has signed requests (dashboard DELETE route guard)
-- — signed rows are retained legal evidence and must not vanish with a
-- casual document delete. A DB-level restrict is deliberately NOT used: it
-- would also block the business-level cascade.
create table if not exists document_signature_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  document_id uuid not null references business_documents(id) on delete cascade,
  token_sha256 text not null,
  -- Who the owner addressed the request to (display + delivery targets).
  signer_name text not null default '',
  signer_email text not null default '',
  signer_phone text not null default '',
  -- Optional note from the owner shown above the document.
  message text not null default '',
  status text not null default 'sent'
    check (status in ('sent', 'viewed', 'signed', 'void')),
  -- Captured at signing: the typed legal name is the signature.
  signature_name text,
  signed_at timestamptz,
  signer_ip text,
  signer_user_agent text,
  -- sha256 of business_documents.content_md at the moment of signing.
  content_sha256 text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_document_signature_requests_token
  on document_signature_requests (token_sha256);

create index if not exists idx_document_signature_requests_document
  on document_signature_requests (document_id, created_at desc);

create index if not exists idx_document_signature_requests_business
  on document_signature_requests (business_id, created_at desc);

alter table document_signature_requests enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated denied by design.
