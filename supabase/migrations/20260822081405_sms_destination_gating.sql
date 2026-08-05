-- International SMS, Phase 2 (server side): destination-country resolution,
-- the anti-pumping gate, and destination logging.
--
-- Phase 1 (weighted_sms_metering) made the monthly cap charge billable text
-- units; this migration adds what "support every country" needs before the
-- Telnyx profile whitelists are widened:
--
--   * sms_dial_codes: E.164 prefix -> ISO country (longest-prefix match via
--     sms_destination_country()). NANP defaults to US with explicit
--     overrides for the Caribbean +1XXX territories; Canada is folded into
--     US here (long-code rate is at/below the US floor, so the distinction
--     carries no cost signal for the log).
--   * try_reserve_sms_outbound_slot gains p_destination_e164 (default null,
--     so already-deployed callers keep working ungated during rollout).
--     When provided, the reserve refuses:
--       - 'destination_blocked'  : denylisted ranges (satellite/premium
--         codes, plus a small IRSF/toll-fraud country list), default-closed
--       - 'destination_unknown'  : the prefix resolves to no known country
--       - 'destination_velocity' : more than 20 sends to one non-US/CA
--         country from one tenant in a rolling hour (SMS-pumping brake;
--         the monthly unit cap remains the hard spend fuse)
--     and the ok-result carries destination_country plus
--     new_destination_country=true on a tenant's FIRST send to a
--     non-US/CA/MX country, which callers surface as an operator alert.
--   * sms_outbound_log.destination_country, filled by trigger so every
--     writer gets it for free: the per-message country the
--     enterprise-pricing re-rating comment has been asking for.
--
-- Destination COST multipliers stay caller-side in TS
-- (src/lib/sms/destination-rates.ts + the _shared lockstep copy): callers
-- fold them into p_text_units, so SQL stays a bookkeeper and the rate table
-- lives in two copies, not three.
-- CREATE OR REPLACE resets function config, so the search_path pin from
-- 20260618194956_pin_function_search_path.sql is re-declared inline.

-- ---------------------------------------------------------------------------
-- Dial-code table (longest-prefix match source)
-- ---------------------------------------------------------------------------
create table if not exists public.sms_dial_codes (
  prefix text primary key,
  iso text not null
);

alter table public.sms_dial_codes enable row level security;
grant select on table public.sms_dial_codes to service_role;

insert into public.sms_dial_codes (prefix, iso) values
  -- NANP: US default, Caribbean territory overrides (longest prefix wins)
  ('1','US'),
  ('1242','BS'),('1246','BB'),('1264','AI'),('1268','AG'),('1284','VG'),
  ('1340','VI'),('1345','KY'),('1441','BM'),('1473','GD'),('1649','TC'),
  ('1658','JM'),('1664','MS'),('1670','MP'),('1671','GU'),('1684','AS'),
  ('1721','SX'),('1758','LC'),('1767','DM'),('1784','VC'),('1787','PR'),
  ('1809','DO'),('1829','DO'),('1849','DO'),('1868','TT'),('1869','KN'),
  ('1876','JM'),('1939','PR'),
  ('20','EG'),('211','SS'),('212','MA'),('213','DZ'),('216','TN'),('218','LY'),
  ('220','GM'),('221','SN'),('222','MR'),('223','ML'),('224','GN'),('225','CI'),
  ('226','BF'),('227','NE'),('228','TG'),('229','BJ'),('230','MU'),('231','LR'),
  ('232','SL'),('233','GH'),('234','NG'),('235','TD'),('236','CF'),('237','CM'),
  ('238','CV'),('239','ST'),('240','GQ'),('241','GA'),('242','CG'),('243','CD'),
  ('244','AO'),('245','GW'),('246','IO'),('248','SC'),('249','SD'),('250','RW'),
  ('251','ET'),('252','SO'),('253','DJ'),('254','KE'),('255','TZ'),('256','UG'),
  ('257','BI'),('258','MZ'),('260','ZM'),('261','MG'),('262','RE'),('263','ZW'),
  ('264','NA'),('265','MW'),('266','LS'),('267','BW'),('268','SZ'),('269','KM'),
  ('27','ZA'),('290','SH'),('291','ER'),('297','AW'),('298','FO'),('299','GL'),
  ('30','GR'),('31','NL'),('32','BE'),('33','FR'),('34','ES'),
  ('350','GI'),('351','PT'),('352','LU'),('353','IE'),('354','IS'),('355','AL'),
  ('356','MT'),('357','CY'),('358','FI'),('359','BG'),
  ('36','HU'),('370','LT'),('371','LV'),('372','EE'),('373','MD'),('374','AM'),
  ('375','BY'),('376','AD'),('377','MC'),('378','SM'),('380','UA'),('381','RS'),
  ('382','ME'),('383','XK'),('385','HR'),('386','SI'),('387','BA'),('389','MK'),
  ('39','IT'),('40','RO'),('41','CH'),('420','CZ'),('421','SK'),('423','LI'),
  ('43','AT'),('44','GB'),('45','DK'),('46','SE'),('47','NO'),('48','PL'),
  ('49','DE'),('500','FK'),('501','BZ'),('502','GT'),('503','SV'),('504','HN'),
  ('505','NI'),('506','CR'),('507','PA'),('508','PM'),('509','HT'),
  ('51','PE'),('52','MX'),('53','CU'),('54','AR'),('55','BR'),('56','CL'),
  ('57','CO'),('58','VE'),('590','GP'),('591','BO'),('592','GY'),('593','EC'),
  ('594','GF'),('595','PY'),('596','MQ'),('597','SR'),('598','UY'),('599','CW'),
  ('60','MY'),('61','AU'),('62','ID'),('63','PH'),('64','NZ'),('65','SG'),
  ('66','TH'),('670','TL'),('672','NF'),('673','BN'),('674','NR'),('675','PG'),
  ('676','TO'),('677','SB'),('678','VU'),('679','FJ'),('680','PW'),('681','WF'),
  ('682','CK'),('683','NU'),('685','WS'),('686','KI'),('687','NC'),('688','TV'),
  ('689','PF'),('690','TK'),('691','FM'),('692','MH'),
  ('7','RU'),('76','KZ'),('77','KZ'),
  ('81','JP'),('82','KR'),('84','VN'),('850','KP'),('852','HK'),('853','MO'),
  ('855','KH'),('856','LA'),('86','CN'),('880','BD'),('886','TW'),
  ('90','TR'),('91','IN'),('92','PK'),('93','AF'),('94','LK'),('95','MM'),
  ('960','MV'),('961','LB'),('962','JO'),('963','SY'),('964','IQ'),('965','KW'),
  ('966','SA'),('967','YE'),('968','OM'),('970','PS'),('971','AE'),('972','IL'),
  ('973','BH'),('974','QA'),('975','BT'),('976','MN'),('977','NP'),
  ('98','IR'),('992','TJ'),('993','TM'),('994','AZ'),('995','GE'),('996','KG'),
  ('998','UZ')
on conflict (prefix) do update set iso = excluded.iso;

-- ---------------------------------------------------------------------------
-- Destination country from an E.164 (longest-prefix match)
-- ---------------------------------------------------------------------------
create or replace function public.sms_destination_country(p_e164 text)
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select d.iso
  from public.sms_dial_codes d
  where regexp_replace(coalesce(p_e164, ''), '[^0-9+]', '', 'g') like '+' || d.prefix || '%'
  order by length(d.prefix) desc
  limit 1;
$$;

grant execute on function public.sms_destination_country(text) to service_role;

-- ---------------------------------------------------------------------------
-- Per-tenant destination history (velocity brake + first-country detection)
-- ---------------------------------------------------------------------------
create table if not exists public.sms_destination_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  country text not null,
  sent_at timestamptz not null default now()
);

create index if not exists idx_sms_destination_events_lookup
  on public.sms_destination_events (business_id, country, sent_at desc);

alter table public.sms_destination_events enable row level security;
grant select, insert, delete on table public.sms_destination_events to service_role;

-- ---------------------------------------------------------------------------
-- Reserve with the destination gate
-- ---------------------------------------------------------------------------
drop function if exists public.try_reserve_sms_outbound_slot(uuid, numeric);

create or replace function public.try_reserve_sms_outbound_slot(
  p_business_id uuid,
  p_text_units numeric default 1,
  p_destination_e164 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tier text;
  v_ent jsonb;
  v_phone text;
  v_timezone text;
  v_limit bigint;
  v_used numeric;
  v_units numeric := greatest(1, coalesce(p_text_units, 1));
  -- Bonus grants are integer texts; round the units for grant arithmetic
  -- (a 2.2-unit MMS consumes 2 bonus texts).
  v_units_int int := greatest(1, round(greatest(1, coalesce(p_text_units, 1)))::int);
  v_today_utc date := (now() at time zone 'utc')::date;
  v_month_start date := date_trunc('month', (now() at time zone 'utc'))::date;
  v_source text := 'plan';
  v_grant_id uuid;
  v_dest_country text;
  v_new_country boolean := false;
  -- Satellite / international-premium number ranges (no ISO country) are
  -- unroutable by the country table and refuse as 'destination_unknown'.
  -- This list refuses countries that DO resolve but are classic toll-fraud
  -- or embargo-priced destinations: Cuba, North Korea, Somalia, Sierra
  -- Leone, Guinea, Guinea-Bissau, Sao Tome. Widen deliberately, never by
  -- accident.
  v_denylist text[] := array['CU', 'KP', 'SO', 'SL', 'GN', 'GW', 'ST'];
begin
  -- Destination gate (only when the caller passes the destination; the
  -- default keeps mid-deploy callers and tests ungated).
  if p_destination_e164 is not null then
    v_dest_country := public.sms_destination_country(p_destination_e164);
    if v_dest_country is null then
      -- Default-closed: a prefix we cannot attribute to a country (includes
      -- satellite +881/+882/+883 and premium +979 ranges) never sends.
      return jsonb_build_object('ok', false, 'reason', 'destination_unknown');
    end if;
    if v_dest_country = any (v_denylist) then
      return jsonb_build_object('ok', false, 'reason', 'destination_blocked');
    end if;
    if v_dest_country not in ('US', 'CA') then
      -- Rolling-hour velocity brake per (tenant, country): slows an
      -- SMS-pumping burst enough for the first-country alert and the
      -- monthly cap to matter. Domestic traffic is exempt.
      if (
        select count(*)
        from public.sms_destination_events e
        where e.business_id = p_business_id
          and e.country = v_dest_country
          and e.sent_at > now() - interval '1 hour'
      ) >= 20 then
        return jsonb_build_object(
          'ok', false,
          'reason', 'destination_velocity',
          'destination_country', v_dest_country
        );
      end if;
      if v_dest_country <> 'MX' then
        v_new_country := not exists (
          select 1
          from public.sms_destination_events e
          where e.business_id = p_business_id
            and e.country = v_dest_country
        );
      end if;
      insert into public.sms_destination_events (business_id, country)
      values (p_business_id, v_dest_country);
      -- Operator alert, written HERE so every caller is covered by one
      -- site: a tenant's first send to a new international country lands in
      -- the admin system-log feed (warn level). SMS-pumping abuse looks
      -- exactly like this the moment it starts.
      if v_new_country then
        insert into public.system_logs (business_id, source, level, event, message, payload)
        values (
          p_business_id,
          'sms_meter',
          'warn',
          'sms_first_send_to_country',
          'First outbound SMS to a new destination country: ' || v_dest_country,
          jsonb_build_object('country', v_dest_country)
        );
      end if;
    end if;
  end if;

  select b.tier, b.enterprise_limits, b.phone, b.timezone
  into v_tier, v_ent, v_phone, v_timezone
  from public.businesses b
  where b.id = p_business_id
  for update;

  if v_tier is null then
    return jsonb_build_object('ok', false, 'reason', 'no_business');
  end if;

  v_limit := public.monthly_sms_cap_for_business(v_tier, v_ent);

  -- Mexican non-enterprise tenants: clamp to 100/month regardless of tier
  -- (units; see the weighted_sms_metering migration). Keep in sync with
  -- SMS_MONTHLY_CAP_MX in supabase/functions/_shared/sms_monthly_limits.ts.
  if v_tier <> 'enterprise'
     and public.business_phone_country(v_phone, v_timezone) = 'MX' then
    v_limit := least(coalesce(v_limit, 100::bigint), 100::bigint);
  end if;

  if v_limit is not null then
    select coalesce(sum(du.sms_text_units), 0)
    into v_used
    from public.daily_usage du
    where du.business_id = p_business_id
      and du.usage_date >= v_month_start;

    if v_used >= v_limit then
      -- Plan cap reached: spill into the purchased bonus balance
      -- (earliest-expiring grant first, matching consume_voice_bonus_seconds).
      -- greatest(0, ...) because one grant may hold fewer texts than this
      -- message's units; the shortfall (at most units-1 texts, only on the
      -- exhausting send) is absorbed rather than split across grants.
      update public.sms_bonus_grants g
      set texts_remaining = greatest(0, g.texts_remaining - v_units_int)
      where g.id = (
        select g2.id
        from public.sms_bonus_grants g2
        where g2.business_id = p_business_id
          and g2.voided_at is null
          and g2.expires_at > now()
          and g2.texts_remaining > 0
        order by g2.expires_at asc, g2.purchased_at asc
        limit 1
        for update
      )
      returning g.id into v_grant_id;

      if v_grant_id is null then
        return jsonb_build_object('ok', false, 'reason', 'monthly_sms_limit');
      end if;
      v_source := 'bonus';
    end if;
  end if;

  -- Use UTC calendar date (matches v_month_start). Using session-local current_date here
  -- created a subtle drift where a send crossing midnight UTC in a non-UTC session would
  -- write into a daily_usage row not counted in the next-window monthly aggregation.
  insert into public.daily_usage (
    business_id,
    usage_date,
    voice_minutes_used,
    sms_sent,
    sms_text_units,
    calls_made,
    peak_concurrent_calls,
    updated_at
  )
  values (p_business_id, v_today_utc, 0, 1, v_units, 0, 0, now())
  on conflict (business_id, usage_date) do update set
    sms_sent = public.daily_usage.sms_sent + 1,
    sms_text_units = public.daily_usage.sms_text_units + excluded.sms_text_units,
    updated_at = now();

  return jsonb_build_object(
    'ok', true,
    'source', v_source,
    'destination_country', v_dest_country,
    'new_destination_country', v_new_country
  );
end;
$$;

revoke all on function public.try_reserve_sms_outbound_slot(uuid, numeric, text) from public;
grant execute on function public.try_reserve_sms_outbound_slot(uuid, numeric, text) to service_role;

-- ---------------------------------------------------------------------------
-- Destination country on every outbound log row (fills via trigger so all
-- writers get it for free; the re-rating hook enterprise-pricing.ts asks for)
-- ---------------------------------------------------------------------------
alter table public.sms_outbound_log
  add column if not exists destination_country text;

comment on column public.sms_outbound_log.destination_country is
  'ISO country of to_e164 (sms_destination_country longest-prefix match), trigger-filled. Enables per-destination cost re-rating.';

create or replace function public.sms_outbound_log_fill_destination()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.destination_country is null then
    new.destination_country := public.sms_destination_country(new.to_e164);
  end if;
  return new;
end;
$$;
-- grants: none (sms_outbound_log_fill_destination): trigger function, runs as owner, never a PostgREST RPC

drop trigger if exists trg_sms_outbound_log_destination on public.sms_outbound_log;
create trigger trg_sms_outbound_log_destination
  before insert on public.sms_outbound_log
  for each row execute function public.sms_outbound_log_fill_destination();
