-- Opt-out provenance: distinguish owner-initiated spam blocks from customer
-- STOPs.
--
-- The Chris Gregoris incident (Jul 24 2026, KYP Ads): flag_contact_spam
-- wrote its suppression through sms_set_opt_out, which coerced every kind to
-- 'stop' — so an owner-initiated block was stored indistinguishably from a
-- customer texting STOP. Customer STOPs are sacred (CTIA / A2P 10DLC: only
-- the customer texting START may lift them); owner-initiated blocks are a
-- platform decision and must be auditable and safely reversible by platform
-- tooling. This migration adds the 'owner_spam' kind:
--
--   * 'stop'       — the customer opted out themselves. Never cleared by
--                    tooling; only the START keyword handler removes it.
--   * 'owner_spam' — the owner declared the contact spam (flag_contact_spam).
--                    Same send-blocking effect everywhere (sms_is_opted_out
--                    is row-existence based and unchanged); reversible by
--                    service-role tooling such as scripts/oneshot/undo-spam-flag.ts.
--
-- The upsert NEVER downgrades: a row already at kind='stop' keeps 'stop'
-- even when an owner later flags the same number — a genuine customer STOP
-- must not become reversible because the owner also called them spam.

alter table public.sms_opt_outs
  drop constraint if exists sms_opt_outs_kind_check;
alter table public.sms_opt_outs
  add constraint sms_opt_outs_kind_check check (kind in ('stop', 'owner_spam'));

comment on column public.sms_opt_outs.kind is
  'stop = the customer texted STOP (sacred; only START lifts it). owner_spam = the owner flagged the contact as spam (same send-blocking effect; reversible by service-role tooling). The upsert never downgrades stop to owner_spam.';

create or replace function public.sms_set_opt_out(
  p_business_id uuid,
  p_sender_e164 text,
  p_kind text default 'stop'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_sender text := nullif(trim(p_sender_e164), '');
  v_kind text := coalesce(nullif(trim(p_kind), ''), 'stop');
  v_was_new boolean := false;
begin
  if v_sender is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_sender');
  end if;
  if v_kind not in ('stop', 'owner_spam') then
    v_kind := 'stop';
  end if;

  insert into public.sms_opt_outs (business_id, sender_e164, kind)
  values (p_business_id, v_sender, v_kind)
  on conflict (business_id, sender_e164) do update set
    -- Never downgrade a customer STOP to a reversible owner block; every
    -- other transition (owner_spam -> owner_spam, owner_spam -> stop) takes
    -- the incoming kind.
    kind = case
      when public.sms_opt_outs.kind = 'stop' then 'stop'
      else excluded.kind
    end,
    updated_at = now()
  returning (xmax = 0) into v_was_new;

  return jsonb_build_object('ok', true, 'new', coalesce(v_was_new, false));
end;
$$;

revoke execute on function public.sms_set_opt_out(uuid, text, text) from public;
grant execute on function public.sms_set_opt_out(uuid, text, text) to service_role;
