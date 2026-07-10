-- ---------------------------------------------------------------------------
-- AiFlow staff-contact tag protection.
--
-- update_contact steps maintain lead-state tags ("New Lead", "Engaged", ...)
-- keyed by an extracted phone var. When a staff member tests a flow with
-- their own number (or a stray extraction lands on a roster phone), those
-- lead-state tags would land on an owner/employee contact row. By default
-- the worker now SKIPS tag updates that target staff (same philosophy as
-- upsert_customer's known-business-contact guard).
--
-- The toggle exists for businesses that intentionally run flows over their
-- own team (e.g. internal task tracking): switching it OFF lets update_contact
-- write tags on any contact.
-- ---------------------------------------------------------------------------

alter table public.businesses
  add column if not exists aiflow_protect_staff_contacts boolean not null default true;

comment on column public.businesses.aiflow_protect_staff_contacts is
  'When true (default), AiFlow update_contact steps skip owner/employee contacts (stored non-customer type, or a phone on the ai_flow_team_members roster) so lead-state tags never land on staff. Toggled from Settings.';
