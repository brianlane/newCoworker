drop policy if exists "Service inserts logs" on coworker_logs;
drop policy if exists "Service role inserts logs" on coworker_logs;
drop policy if exists "Service role inserts logs (Rowboat via service key)" on coworker_logs;

create policy "Service role inserts logs"
  on coworker_logs for insert
  with check (auth.role() = 'service_role');
