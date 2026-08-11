-- Let a workspace connection carry its OWN OAuth tokens instead of a Nango pointer.
--
-- Outlook is moving off Nango onto our own Microsoft OAuth. The transport
-- choice lives in a COLUMN here rather than in a separate microsoft_connections
-- table, because this row's `id` is persisted inside AiFlow definitions
-- (send_email.fromConnectionId, email_organize.connectionId, the email-trigger
-- mailbox binding). It is validated on write, guarded on delete by
-- flowsReferencingWorkspaceConnection, and resolved at run time. Splitting the
-- id space across two tables would break that delete guard.
--
-- Keeping provider_config_key = 'outlook' for both transports also means the
-- resolvers (src/lib/voice-tools/connections.ts) never learn there are two, so
-- a later Google-direct rollout is a registry entry rather than an edit to six
-- separate provider-key lists.
--
-- 'nango' rows are unchanged: no tokens here, Nango still holds them.
-- 'direct' rows carry the token pair and expiry, and their connection_id is a
-- synthetic `direct:<uuid>` that exists only to satisfy NOT NULL and the
-- (business_id, provider_config_key, connection_id) unique key.
--
-- Tokens are AES-256-GCM envelopes (`enc:v1:<iv>:<tag>:<ct>`) written through
-- encryptIntegrationSecret (src/lib/integrations/secrets.ts), same as
-- zoom_connections / slack_connections / meta_connections. The table was moved
-- to the deny-all posture (RLS on, zero policies, service_role only) in the
-- preceding migration specifically so this ciphertext has no client-reachable
-- path.

alter table public.workspace_oauth_connections
  -- Which side holds the grant. Existing rows are all Nango, hence the default.
  add column if not exists transport text not null default 'nango',
  -- Direct rows only; null on Nango rows.
  add column if not exists access_token_encrypted text,
  add column if not exists refresh_token_encrypted text,
  -- Access-token expiry; the client refreshes when <60s remain.
  add column if not exists token_expires_at timestamptz,
  -- Scope string as the provider actually granted it, which can differ from
  -- what we requested. Kept so a missing-permission failure is diagnosable
  -- without re-running consent.
  add column if not exists oauth_scope text,
  -- Soft-disable: set false when a refresh comes back invalid_grant (owner
  -- revoked, password change, admin revocation). The card then reads
  -- "needs reconnect" instead of the connection silently failing every poll.
  add column if not exists is_active boolean not null default true;

alter table public.workspace_oauth_connections
  drop constraint if exists workspace_oauth_connections_transport_check;
alter table public.workspace_oauth_connections
  add constraint workspace_oauth_connections_transport_check
  check (transport in ('nango', 'direct'));

-- A direct row without a usable token pair is not a connection, it is a
-- half-written one. Enforce in the database so a partial callback cannot leave
-- a row that every later read has to defend against.
alter table public.workspace_oauth_connections
  drop constraint if exists workspace_oauth_connections_direct_tokens_check;
alter table public.workspace_oauth_connections
  add constraint workspace_oauth_connections_direct_tokens_check
  check (
    transport <> 'direct'
    or (
      access_token_encrypted is not null
      and refresh_token_encrypted is not null
      and token_expires_at is not null
    )
  );

-- The refresh path resolves a business's direct rows; the Nango rows are the
-- overwhelming majority today, so keep the index off the common case.
create index if not exists workspace_oauth_connections_direct_idx
  on public.workspace_oauth_connections (business_id)
  where transport = 'direct';

-- No new grants: these are columns on an existing table, and the preceding
-- migration already set the table's grants to service_role only.
