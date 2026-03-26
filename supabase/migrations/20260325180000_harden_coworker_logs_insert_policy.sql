drop policy if exists "Service inserts logs" on coworker_logs;

create policy "Service role inserts logs"
  on coworker_logs for insert
  with check (auth.role() = 'service_role');
