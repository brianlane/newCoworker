-- Business-local timezone (IANA name, e.g. "America/Phoenix").
--
-- Until now every AI surface (SMS, dashboard chat, voice) pinned its
-- date/time preamble line to UTC because businesses stored no timezone, so
-- "tomorrow at 2pm" resolved against UTC and could land on the wrong local
-- day/hour. Captured from the owner's browser at onboarding and editable in
-- Settings. Null = legacy UTC behavior (validated as an IANA name in the
-- app layer; no DB-side check since Postgres' zone list can drift from V8's).

alter table businesses
  add column if not exists timezone text;

comment on column businesses.timezone is
  'IANA timezone (e.g. America/Phoenix) used for AI date/time context and calendar tool defaults. Null = UTC.';
