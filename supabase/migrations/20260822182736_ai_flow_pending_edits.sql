-- Staged AiFlow edits: the thing an owner actually confirms.
--
-- Until now the confirmation requirement for `edit_aiflow` was a SENTENCE IN
-- A TOOL DESCRIPTION ("Use ONLY after the owner explicitly confirmed the
-- exact changes"). Nothing enforced it, and a model handed a written-out
-- multi-part spec will reasonably read it as already-confirmed, because the
-- owner did write it all out. On the owner-SMS surface that means a text
-- message can rewrite live automations in one turn.
--
-- The gate is now a two-call protocol. The first call compiles the edit and
-- stages it here, writing nothing to ai_flows; the second call applies the
-- staged row by token. The owner sees a real diff in between.
--
-- Why the compiled definition is STORED rather than recompiled on confirm:
-- `edit_aiflow` regenerates a whole definition through a model rather than
-- patching one, so recompiling the same instruction can produce a different
-- result. Confirming a described change and then applying a freshly
-- generated one would make the confirmation meaningless. The bytes the owner
-- agreed to are the bytes that land.

create table if not exists public.ai_flow_pending_edits (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  flow_id uuid not null references public.ai_flows(id) on delete cascade,
  -- Opaque handle the model echoes back to confirm. Unique so a token can
  -- never address two staged edits.
  token text not null unique,
  -- The EXACT definition to write on confirm.
  definition jsonb not null,
  -- Set only when the edit also renames the flow.
  new_name text,
  -- Plain-English diff lines the model must read out before asking.
  summary jsonb not null default '[]'::jsonb,
  -- Questions that must be answered before this can be confirmed at all. A
  -- non-empty list makes the staged edit unconfirmable by design.
  ambiguities jsonb not null default '[]'::jsonb,
  -- 'wording' | 'structural' | 'in_flight': how far the edit reaches. See
  -- src/lib/ai-flows/edit-diff.ts.
  risk text not null check (risk in ('wording', 'structural', 'in_flight')),
  -- The flow's updated_at when the diff was computed. On confirm this must
  -- still match, or the edit is stale: someone changed the flow in between
  -- and the owner would be approving a diff against a definition that is no
  -- longer live.
  base_updated_at timestamptz not null,
  -- Where the request came from, for the definition history's edit_source.
  surface text,
  actor text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Single use: stamped when the edit is applied, so a replayed token is a
  -- refusal rather than a second write.
  consumed_at timestamptz
);

-- Confirm hot path: token lookup.
create unique index if not exists ai_flow_pending_edits_token_idx
  on public.ai_flow_pending_edits (token);

-- "What is staged on this flow?" plus the expiry sweep.
create index if not exists ai_flow_pending_edits_flow_idx
  on public.ai_flow_pending_edits (flow_id, created_at desc);

alter table public.ai_flow_pending_edits enable row level security;

-- Service-role-only (RLS on, zero policies): staged edits are read and
-- consumed by the tool handlers, never by a browser client.
grant select, insert, update, delete
  on table public.ai_flow_pending_edits to service_role;

comment on table public.ai_flow_pending_edits is
  'Edits compiled but NOT applied, awaiting the owner''s explicit yes. The second edit_aiflow call applies the stored definition by token; the definition is stored rather than recompiled because the compile step regenerates a whole definition and is not reproducible.';
comment on column public.ai_flow_pending_edits.base_updated_at is
  'ai_flows.updated_at when the diff was computed. A mismatch on confirm means the flow moved underneath the staged edit, so the owner would be approving a diff that no longer describes reality.';
comment on column public.ai_flow_pending_edits.ambiguities is
  'Open questions blocking confirmation. Non-empty means the staged edit cannot be applied at all until a fresh staging resolves them.';
