-- Allow cancel_reason = 'stripe_external' on subscriptions.
--
-- In-app cancel paths (refund, period-end, payment failure, admin force)
-- stamp a reason and email the owner. Stripe Customer Portal / Dashboard
-- cancels arrive as customer.subscription.deleted with no lifecycle
-- cancelReason, so the fallback mirror left cancel_reason NULL and sent
-- neither the owner confirmation nor an ops alert (Scar Fairy, 2026-09-17).
--
-- 'stripe_external' is that missing vocabulary: a cancel Stripe already
-- committed, which we then finalize locally (grace window, owner email,
-- ops email). The ordering is in TypeScript; this constraint only pins
-- the allowed values.

alter table public.subscriptions
  drop constraint if exists subscriptions_cancel_reason_check;

alter table public.subscriptions
  add constraint subscriptions_cancel_reason_check
  check (
    cancel_reason is null or cancel_reason in (
      'user_refund',
      'user_period_end',
      'payment_failed',
      'admin_force',
      'upgrade_switch',
      'stripe_external'
    )
  );

comment on column public.subscriptions.cancel_reason is
  'Why this subscription left: user_refund, user_period_end, payment_failed, admin_force, upgrade_switch (plan change), stripe_external (Customer Portal / Dashboard / API, not our cancel UI). Null on live rows.';

-- grants: none (no object is created here; the table's existing service_role
-- grants are unchanged by widening a check constraint).
