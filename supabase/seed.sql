insert into businesses (id, name, owner_email, tier, status)
values
  ('11111111-1111-1111-1111-111111111111', 'Mock Realty', 'owner@example.com', 'starter', 'online')
on conflict do nothing;
