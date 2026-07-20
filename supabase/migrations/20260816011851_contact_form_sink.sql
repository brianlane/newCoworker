-- Platform contact-form sink.
--
-- At most ONE business can be designated to receive /contact submissions as
-- webhook-channel AiFlow events (source "contact_form") — the internal HQ
-- dogfood tenant. Flipped from the admin business page ("Contact form
-- (platform)" card) via POST /api/admin/contact-form-sink; the public
-- contact route resolves the sink per submission, so no sink means exactly
-- the pre-existing email-only behavior.
alter table businesses
  add column if not exists contact_form_sink boolean not null default false;

comment on column businesses.contact_form_sink is
  'When true, public /contact submissions also enqueue webhook flow events for this business (admin-designated, at most one).';

-- One sink, fleet-wide: enabling a second business without clearing the
-- first is a unique violation, not a silent split-brain.
create unique index if not exists uq_businesses_contact_form_sink
  on businesses (contact_form_sink)
  where contact_form_sink;
