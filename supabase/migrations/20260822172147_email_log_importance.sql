-- email_log.importance: a 1-10 relative importance score for one message,
-- written by the AiFlow `email_organize` step and read ONLY for display.
--
-- Display-only is the whole design, not a limitation waiting to be lifted. The
-- value comes from a language model, and models are poorly calibrated on
-- unanchored numeric scales: they cluster on a few values and drift between
-- runs on identical input. That is fine for ORDERING a list (roughly-right
-- ranking is still useful) and unacceptable for ROUTING (whether to text the
-- owner at 3am must not hinge on a 4-versus-5 the model cannot reproduce).
-- Routing decisions stay on the named `classify` categories, which are
-- editable prose a human can debug when they misfire.
--
-- So: nothing in the engine, the alerting path, or the digest may branch on
-- this column. It sorts the dashboard Emails page and nothing else.
--
-- Nullable with no default, because "the flow never scored this" and "the flow
-- scored it 1" are different facts and the Emails page sorts unscored rows to
-- the bottom rather than treating them as least important.
alter table public.email_log
  add column if not exists importance smallint
    check (importance is null or (importance between 1 and 10));

comment on column public.email_log.importance is
  'Model-assigned 1-10 relative importance for this message, written by the AiFlow email_organize step. DISPLAY AND SORT ONLY: never branch alerting, routing, or digest behavior on it (LLM scores are not reproducible enough to gate on). Null means never scored.';

-- Sorting the Emails page by importance within one business. Partial, since
-- only scored rows are ever ordered by it and most rows carry null.
create index if not exists email_log_business_importance_idx
  on public.email_log (business_id, importance desc)
  where importance is not null;

-- grants: none (email_log.importance): adding a column to an existing table
-- inherits that table's Data API grants; no new object is created here.
