# Hosted development environment

Status (2026-09-12): deployed on the existing Vercel Hobby team. Public source: https://github.com/Queue-Solutions/whatsapp-ai-platform. Stable development URL: https://whatsapp-ai-platform-dev.vercel.app. No paid plan or trial was activated. Meta callback verification and real English/Arabic round trips passed on the hosted app. Supabase recovery scheduling is active and verified. With the local server and tunnel stopped, the minute job processed one queued diagnostic, returned HTTP 200, and produced one delivered reply.

## Hosting decision

The user selected Vercel Hobby for the temporary test environment and a public repository. No paid plan or trial is authorized. Vercel lists Hobby for personal, non-commercial use; changing repository visibility or the scheduler does not change those usage terms. The deployment configuration omits Vercel Cron. Supabase Cron is the selected scheduler for recovering pending work.

References: [Vercel plans](https://vercel.com/pricing), [cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [securing cron](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

## Vercel settings

- Create a dedicated project named `whatsapp-ai-platform-dev` from the public Queue Solutions repository. Keep all WhatsApp assets in test mode.
- Framework: Next.js; root directory: repository root; Node.js: 24.x; install: `npm ci`; build: `npm run build`; output directory: framework default.
- `vercel.json` places functions in Dublin near the existing Supabase database and leaves scheduling to Supabase Cron. This is a recovery worker for low-volume development; each call handles one job, while incoming webhooks also trigger processing. Monitor backlog before increasing traffic.
- Use Vercel's Production environment for the stable **development-project** URL. This does not make the WhatsApp channel a production channel. Preview branches must not receive the shared live test credentials or drain the development queue.
- The callback route must be reachable by Meta without an interactive Vercel login or browser challenge. Scope any protection changes to this dedicated development project; keep signature validation enabled. The worker endpoint always requires bearer authentication.

## Server environment

Copy values securely from local configuration into the Vercel project's Production environment. Never upload the `.env.local` file or put credentials in Git. `.vercelignore` excludes environment files from source uploads.

Required names:

```
SUPABASE_URL
SUPABASE_SECRET_KEY
META_APP_SECRET
WHATSAPP_VERIFY_TOKEN
META_GRAPH_API_VERSION
WHATSAPP_ACCESS_TOKEN
WHATSAPP_TEST_PHONE_NUMBER_ID
WHATSAPP_TEST_RECIPIENTS
WHATSAPP_MODE
CRON_SECRET
```

Keep `WHATSAPP_MODE=test`. Keep the verified temporary Phone Number ID and approved recipient. The Supabase scheduler sends `CRON_SECRET` as its Authorization bearer token, retrieved from Vault at runtime. Do not deploy `SMOKE_BASE_URL`; that is only for local diagnostics. Temporary Meta access tokens expire: replace the value and redeploy when renewed. Never assume a server stays authenticated indefinitely.

## Verification and cutover

1. Run the repository checks and deploy the dedicated development project after the hosting decision.
2. Check `/api/health` for HTTP 200, unsigned webhook POST for HTTP 403, and unauthenticated worker requests for HTTP 401. Verify the protected worker succeeds using a server-side request that does not print the secret.
3. Change Meta's callback to the stable project domain plus `/api/webhooks/whatsapp`, using the same verify token. Keep client-certificate attachment disabled. Confirm the `messages` field and test WABA app subscription remain enabled.
4. Send real English and Arabic messages from the approved recipient. Confirm completed jobs, persisted inbound/outbound records, and Meta delivery receipts.
5. Configure Supabase Cron using `supabase/operations/configure-worker.sql` after adding the worker URL and secret in Supabase Vault. Verify the HTTP response status in `net._http_response` as well as the cron run status, and check that pending jobs are not accumulating. Never claim scheduling is active from the committed configuration alone.
6. Only after hosted delivery and scheduling are verified, stop the local tunnel and backend. Do not alter or register the client's phone number.

## Failure handling

Use the last known working deployment for rollback, preserving the database and message history. Fix failed credentials before retrying an explicitly rejected send. Do not reset `sending` or `needs_review` jobs automatically; reconcile uncertain outcomes first. Database migration changes require forward migrations or reviewed recovery, never a remote reset.

## Before client traffic

The echo foundation is not production-ready for clients. Complete authenticated admin access, audited handoff controls, protected per-channel credentials, long-lived Meta authorization, queue monitoring, usage controls, and verified Coexistence onboarding. See `CLIENT-CHAT-PRESERVATION.md` and `ROADMAP.md`.

## Background recovery on Supabase

The normal webhook stores messages before acknowledging Meta and then tries one queued job. The minute scheduler is a backup for interruptions; it calls the protected worker only if this development tenant has pending work or expired processing/sending leases. Lease handling prevents concurrent workers from processing the same job. Expired sending attempts are marked for review instead of being sent again.

In Supabase Vault, save `queue_dev_worker_url` as the deployed URL ending `/api/internal/process-messages`, and `queue_dev_worker_secret` as the same value as Vercel's `CRON_SECRET`. Create/update them through the authenticated dashboard; keep plaintext secrets out of SQL files, Git, and logs. Apply `supabase/operations/configure-worker.sql` as the database administrator. It updates a consistently named cron job, validates configuration, and sends no HTTP requests when there is no eligible work. The scheduler is for this low-volume development tenant; future deployments need their own configuration and capacity planning.

Monitor HTTP responses as well as job run history: a successful `pg_cron` execution means the HTTP request was queued, not that the worker finished. For errors, check HTTP status codes and application job states. To stop recovery, run `select cron.unschedule('queue-dev-message-recovery');`. This does not delete messages or jobs.

## Repository connection

The repository is public. The first hosted release was deployed using the Vercel CLI. The owner then granted the existing Vercel GitHub integration access to this repository, and the project was connected successfully. Pushes to main trigger Vercel deployment; GitHub Actions runs validation separately, so check CI before promoting changes. Preview environments do not receive the development credentials. Manual deployment remains available with `vercel deploy --prod --scope queuesolutions`. No Vercel token is stored in GitHub Actions.

Standard Protection remains enabled: preview URLs and generated deployment URLs require Vercel access; the stable production domain for this development project is public. Its webhook still requires the Meta signature and its worker requires the private bearer token.
