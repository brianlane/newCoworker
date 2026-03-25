alter table businesses
  add column if not exists business_type text,
  add column if not exists owner_name text,
  add column if not exists phone text,
  add column if not exists service_area text,
  add column if not exists typical_inquiry text,
  add column if not exists team_size integer,
  add column if not exists crm_used text;
