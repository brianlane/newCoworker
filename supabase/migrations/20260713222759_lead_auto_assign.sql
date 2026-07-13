-- Per-business lead auto-assignment (Truly feedback Issue 7, 2026-07-13).
--
-- Default (false) keeps the offer-and-claim model: route_to_team texts the
-- next roster member in rotation and parks awaiting their "1" reply, so a
-- lead is never silently assigned to someone unavailable. When a business
-- flips this ON, the rotation pick IS the assignment: the run records the
-- claim immediately (claimed_agent set, contact ownership assigned, claimed
-- goal fired), the teammate gets an assignment FYI instead of an offer, and
-- Tasks shows the lead as assigned instead of Unclaimed.
--
-- Toggled from the Employees page (POST /api/business/lead-auto-assign).

alter table businesses
  add column if not exists lead_auto_assign boolean not null default false;

comment on column businesses.lead_auto_assign is
  'When true, route_to_team hard-assigns each lead to the next roster member in rotation (assignment FYI, no claim handshake). Default false = offer-and-claim.';
