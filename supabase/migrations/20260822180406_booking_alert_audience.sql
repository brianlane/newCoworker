-- Who hears about a confirmed booking.
--
-- maybeAlertUnassignedBooking already fires on EVERY confirmed booking (the
-- existing flag is named unassigned_booking_alerts, but it dispatches on all
-- three ownership states: solo, covered, unowned). What it could not do is
-- tell anyone other than the business owner.
--
-- Amy Laidlaw Real Estate, 2026-08-17: "Notify owner on all appointments
-- booked", with employees wanted on the same alert. Two columns rather than
-- one, because "which employees" is a separate question from "employees at
-- all":
--
--   booking_alert_audience    owner | employees | both
--   booking_alert_member_ids  NULL = every active member, otherwise just these
--
-- Default 'owner' with a NULL id list, which is exactly today's behavior, so
-- every existing tenant is unchanged until someone opts in.
--
-- grants: none (no new objects) - columns inherit notification_preferences'
-- existing service_role grants.

alter table public.notification_preferences
  add column if not exists booking_alert_audience text not null default 'owner',
  add column if not exists booking_alert_member_ids uuid[];

-- Named so a bad write fails loudly here rather than silently alerting the
-- wrong audience. Guarded because add-column-if-not-exists reruns.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'notification_preferences_booking_alert_audience_check'
  ) then
    alter table public.notification_preferences
      add constraint notification_preferences_booking_alert_audience_check
      check (booking_alert_audience in ('owner', 'employees', 'both'));
  end if;
end $$;

comment on column public.notification_preferences.booking_alert_audience is
  'Who receives the confirmed-booking alert: owner (default, today''s behavior), employees, or both.';

comment on column public.notification_preferences.booking_alert_member_ids is
  'Restrict the employee half of the booking alert to these ai_flow_team_members ids. NULL means every active member. Ignored when the audience is owner.';
