-- Manual post-approval operation, not a migration. Do not execute during preparation.
-- Vault URL must target the deployed pilot worker; secret is the server CRON_SECRET.
-- Values never appear in the schedule text. The existing dev schedule is untouched.
begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;
do $$
declare worker_url text; worker_secret text;
begin
  select decrypted_secret into worker_url from vault.decrypted_secrets where name='queue_pilot_worker_url';
  select decrypted_secret into worker_secret from vault.decrypted_secrets where name='queue_pilot_worker_secret';
  if worker_url is null or worker_url !~ '^https://[a-z0-9-]+\.vercel\.app/api/internal/process-messages\?channel=pilot$' then
    raise exception 'Configure the deployed pilot worker URL in Vault first';
  end if;
  if worker_secret is null or length(worker_secret)<32 then raise exception 'Configure the pilot worker secret in Vault first'; end if;
end; $$;
select cron.schedule('queue-pilot-message-recovery','* * * * *',$job$
  select net.http_post(
    url:=(select decrypted_secret from vault.decrypted_secrets where name='queue_pilot_worker_url'),
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||
      (select decrypted_secret from vault.decrypted_secrets where name='queue_pilot_worker_secret')),
    body:='{}'::jsonb,timeout_milliseconds:=55000
  ) where exists(
    select 1 from public.message_jobs j
    join public.messages m on m.id=j.inbound_message_id and m.tenant_id=j.tenant_id
    join public.whatsapp_channels ch on ch.id=m.channel_id and ch.tenant_id=j.tenant_id
    join public.whatsapp_pilot_authorizations p on p.channel_id=ch.id and p.tenant_id=ch.tenant_id
    where ch.mode='pilot' and p.approved_at is not null and
      ((p.sending_enabled and ch.enabled and ch.assistant_scope='selected' and j.state='pending') or
       (j.state in ('processing','sending') and j.leased_until<now()))
  );
$job$);
commit;
