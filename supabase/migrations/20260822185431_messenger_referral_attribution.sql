-- Click-to-Messenger attribution was being thrown away.
--
-- When someone opens a conversation from a Facebook or Instagram ad, or from
-- an m.me / ig.me link carrying a ref code, Meta sends a `referral` naming the
-- ad and the campaign. We never subscribed `messaging_referrals` and the
-- parser had no slot for it, so for a product whose core use case is Meta lead
-- ads we could not answer "which ad produced this conversation".

alter table public.messenger_conversations
  add column if not exists referral jsonb;

comment on column public.messenger_conversations.referral is
  'Click-to-Messenger / ig.me attribution as Meta sent it: ref, source, type, ad_id, and the ads_context_data title when present. Written once, on the FIRST referral seen for the thread, so a later re-entry from a different ad cannot overwrite what actually started the conversation.';

-- Attribution reporting reads "conversations from ads", which is a small
-- slice of the table.
create index if not exists idx_messenger_conversations_referral
  on public.messenger_conversations ((referral -> 'ad_id'))
  where referral is not null;
