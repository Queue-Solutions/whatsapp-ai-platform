# Queue Solutions · WhatsApp AI platform foundation

Next.js + TypeScript + Supabase, using **Meta's temporary test number only**. The response mode defaults to diagnostic echo. A bounded OpenAI strategy can answer from approved dashboard knowledge when enabled; see `docs/BOUNDED-AI.md`.

## Current milestone

The hosted development bot uses semantic AI intent classification followed by deterministic workflow execution and bounded answers from approved business knowledge. The authenticated inbox provides history, delivery status, audited pause/resume and manual text replies. See `docs/AI-ROUTING.md` for the routing boundaries.

Real English and Arabic WhatsApp → webhook → Supabase → echo flows were verified on 2026-09-12, including Meta delivery receipts. The hosted development app is https://whatsapp-ai-platform-dev.vercel.app. Its Supabase minute recovery timer was verified with the local server and tunnel stopped. See `docs/VALIDATION.md` for evidence.

Signed WhatsApp webhook → customer/conversation/inbound message + durable job committed together → `processIncomingMessage()` → saved outbound intent → Meta text reply → delivery receipts.

The webhook acknowledges after persistence. Next.js `after()` attempts one queued message after the response. A protected worker endpoint drains one more per call. The hosted development environment has Supabase Cron configured; **configure a recurring worker invocation for each separate deployment**; `after()` alone is not a durable scheduler. The simple one-message worker is deliberately for low-volume development.

## Run locally

1. Use Node.js 24.x, then `npm ci`.
2. Copy `.env.example` to `.env.local` if absent. Keep it out of Git; fill the Supabase URL and backend secret key.
3. Apply the SQL files in `supabase/migrations` once each, in filename order, to an empty development database. For an existing database, apply only its missing forward migrations; never replay the foundation or reset the database. The current worker requires the inbox migration even in echo mode. For later CLI use, follow the migration-history note below.
4. Run `npm run check:supabase` to verify the connection and schema.
5. Follow `docs/META-TEST-NUMBER.md` to fill Meta settings and seed the development tenant/channel.
6. Run `npm run dev`. The service page is at `http://localhost:3000`.

`npm run check` runs lint, TypeScript,  PostgreSQL-backed tests, and a production build. Tests use isolated in-memory PostgreSQL through PGlite and fake Meta sends; they need no account credentials and send no real messages. This validates the migration and RLS SQL, but is not a replacement for testing hosted Supabase/PostgREST and real Meta delivery.

## Routes

| Route | Purpose |
|---|---|
| `GET /api/webhooks/whatsapp` | Meta verification challenge |
| `POST /api/webhooks/whatsapp` | Signed inbound messages and delivery events |
| `GET/POST /api/internal/process-messages` | Worker; requires `Authorization: Bearer <CRON_SECRET>` |
| `GET /api/health` | Process liveness and configured reply strategy; no claim of database/Meta readiness |
| `/dashboard/inbox` | Authenticated conversation history and pause/resume controls |
| `POST /api/dashboard/reply` | Manual text reply; requires a verified member session |

No unauthenticated simulator, admin API, or dashboard data endpoint is exposed.

## Code map

- `src/app/api`: thin HTTP routes.
- `src/modules/whatsapp`: signature checking, payload parser, guarded Cloud API sender.
- `src/modules/messaging`: core processor, strategy contract, durable repository adapter.
- `src/modules/knowledge`: tenant-scoped published FAQ/fact lookup.
- `src/modules/ai/contracts.ts`: future AI/retrieval, lead-intent and explicit CSAT contracts.
- `supabase/migrations`: tenant model, RLS/grants, customer history, knowledge and transactional job functions.
- `tests`: signed webhook pipeline and database/security/failure regression tests.

## Delivery semantics

Meta can redeliver events. Inbound IDs are unique per channel, and ingestion plus job creation is atomic. Claims use leases and serialize active work per conversation. Expired processing leases can retry, at most three attempts. The processor checks human takeover, channel enablement, and a conservative customer service window immediately before recording a send intent.

Sending to Meta and committing its response cannot share one database transaction. If a request times out, a successful response has no message ID, or the process dies after the send begins, the job goes to `needs_review` rather than automatically risking a second reply. Exactly-once external delivery is not guaranteed. Explicit 4xx rejections become `failed`; fix the cause and reconcile before any manual retry. Never blindly reset `sending`/`needs_review` jobs to pending.

Status events are stored even if they arrive before the outbound provider ID is committed. They are deduplicated and applied without downgrading read/delivered progress. Job completion means Meta accepted the send; use message delivery status to distinguish sent, delivered, read, and failed.

## Security and reuse

Every client-owned record has a tenant ID; composite foreign keys prevent cross-tenant relations. Channels resolve tenant identity on the server. No tenant ID from a public webhook is trusted. Browser roles have no worker or sending RPC access; a narrow authenticated RPC supports audited pause/resume; authenticated members can read their tenant's data, and only owners/admins can edit its knowledge. The authenticated business knowledge editor is at `/dashboard`; see `docs/ADMIN-KNOWLEDGE.md` for its public-key and account setup. Account provisioning remains an administrator operation. The privileged Supabase client must remain on the server, behind authorization.

This first deployment configures one test channel and token. Additional Queue Solutions clients need a secret-manager-backed credential resolver per channel, authenticated tenant administration and production onboarding. The schema supports multiple tenants; one environment token is not a production multi-client credential system.

Read `docs/CLIENT-CHAT-PRESERVATION.md` before any client onboarding.

## Migration history

SQL Editor application does not populate the Supabase CLI migration-history table. If switching to the CLI later, link the **development** project and verify the schema matches this file, then mark version `202609120001` as applied using `supabase migration repair --status applied 202609120001`. Future migrations can use `supabase db push`. Do not replay this baseline, run a remote reset, or use migration repair to hide a mismatched schema.

## Deployment

The Vercel development configuration is in `vercel.json` with no Vercel Cron schedule. Supabase Cron can invoke the recovery worker every minute using Vault-backed authorization. See `docs/DEPLOYMENT.md` for deployment, scheduler setup, and hosting-plan constraints. Configuration files alone do not prove hosting or scheduling is active.

## Next milestones

See `docs/ROADMAP.md`. AI replies are optional and bounded; document RAG, lead scoring, inferred sentiment, analytics and CSAT collection remain future work.

Reference documentation: [Supabase keys](https://supabase.com/docs/guides/getting-started/api-keys), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [migrations](https://supabase.com/docs/guides/deployment/database-migrations), [Meta's webhook signature example](https://github.com/fbsamples/whatsapp-api-examples/tree/main/signature-validation-with-webhooks-payloads), [Next.js installation](https://nextjs.org/docs/app/getting-started/installation).

## Business knowledge editor

`/dashboard` provides email/password sign-in, tenant-scoped branches/hours/Google Maps fields, and twelve blank starter FAQs. Owners/admins can save drafts and approve completed entries. See `docs/ADMIN-KNOWLEDGE.md`. The inbox is available at `/dashboard/inbox`; see `docs/INBOX.md`. Analytics remains future work. See `docs/BOUNDED-AI.md` for the optional approved-knowledge reply mode and its $0.25 development allowance.

## AI allowance and acceptance

The forward bounded-AI migration adds tenant-isolated usage records, a shared non-renewing $0.25 development allowance, durable request deduplication, and source/handoff checks immediately before a send. Real fixed-fixture acceptance runs on a separately authenticated, temporarily enabled internal endpoint without WhatsApp sends. See `docs/BOUNDED-AI.md`.
