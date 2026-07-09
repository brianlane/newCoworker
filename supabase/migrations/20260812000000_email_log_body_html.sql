-- Store the sanitized-at-display HTML body of inbound AI-mailbox mail so the
-- dashboard reading pane can render the real email (styling + clickable
-- links) instead of the flattened text. Nullable: rows predating capture and
-- text-only messages simply have no HTML alternative.
alter table email_log add column if not exists body_html text;
