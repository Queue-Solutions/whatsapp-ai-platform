-- Retain only the identity of deleted starter FAQs so they stay dismissed on reload.
alter table public.faqs add column deleted_at timestamptz;
alter table public.faqs add constraint deleted_faq_not_published
  check (deleted_at is null or not is_published);
