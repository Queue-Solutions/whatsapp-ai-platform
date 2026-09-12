-- Apply as the development database administrator AFTER deploying the worker.
-- Store queue_dev_worker_url and queue_dev_worker_secret in Supabase Vault first.
-- Do not place literal credentials in this file or cron command text.
begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

do $$
declare worker_url text; worker_secret text;
begin
  select decrypted_secret into worker_url from vault.decrypted_secrets where name = 'queue_dev_worker_url';
  select decrypted_secret into worker_secret from vault.decrypted_secrets where name = 'queue_dev_worker_secret';
  if worker_url is null or worker_url !~ '^https://[a-z0-9-]+\.vercel\.app/api/internal/process-messages$' then
    raise exception 'Configure the deployed Vercel worker URL in Vault first';
  end if;
  if worker_secret is null or length(worker_secret) < 32 then
    raise exception 'Configure the worker secret in Vault first';
  end if;
end;
$$;

select cron.schedule(
  'queue-dev-message-recovery',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'queue_dev_worker_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'queue_dev_worker_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  )
  where exists (
    select 1 from public.message_jobs j
    join public.messages m on m.id = j.inbound_message_id and m.tenant_id = j.tenant_id
    join public.whatsapp_channels ch on ch.id = m.channel_id and ch.tenant_id = j.tenant_id
    where j.tenant_id = '11111111-1111-4111-8111-111111111111'::uuid
      and ch.mode = 'test'
      and (j.state = 'pending' or (j.state in ('processing','sending') and j.leased_until < now()))
  );
  $job$
);
commit;
