# IRAM pilot preparation — 5 November 2026

## Status and scope

Local implementation only. No migration has been applied remotely, no environment
settings have been changed, and no Meta routing, registration, subscription,
billing or messages have been changed by this work. Existing test-number operation
remains the default. Do not activate the client number under the foundation-only
authorization in AGENTS.md; a reviewed live cutover needs separate authorization.

IRAM's supplied Graph result identifies +201200889966, Phone Number ID
1869418956471750, `is_on_biz_app=true`, `platform_type=CLOUD_API`. This supports
using the existing coexistence registration. It does not prove delivery to Queue,
identify the subscribed callback, or grant this deployment access to the number.
No new registration, migration, QR pairing or deletion is part of this plan.

The existing AI model, prompt, knowledge retrieval, moderation policy, ticket and
handoff behavior are unchanged. Group conversations and phone-app echoes/history
do not become AI turns. Replies sent by a person from the Business app do not
automatically pause Queue; use the existing dashboard pause control during testing.

## Independent controls

1. Deployment: `WHATSAPP_PILOT_ENABLED=false` by default. The pilot webhook returns
   503 until explicitly configured. `WHATSAPP_PILOT_SEND_ENABLED=false` independently
   prevents both automatic and dashboard sends. All `WHATSAPP_PILOT_*` credentials
   are server-only and separate from the unchanged test configuration.
2. Trusted channel: mode `pilot`, exact Phone Number ID and exact tenant UUID must
   match deployment settings. The database channel is created disabled with
   assistant scope `off`. No client channel or authorization row is seeded.
3. Service-only approval: `whatsapp_pilot_authorizations` binds tenant and channel,
   an approval timestamp, receive/send switches and a tester allowlist. Browser
   roles have neither access to this table nor execution rights on internal helpers.
4. Recipients must pass the deployment and database allowlists. Hidden-number
   aliases use existing active, channel-scoped verified identities; retired
   identifiers never transfer approval. Unapproved incoming chats are ignored.
5. Automatic pilot replies require **Selected chats only**, plus the existing
   individual pause, blacklist, fresh customer-service window, moderation and job
   lease checks. Company-wide `all` is unavailable for pilot channels.
6. The existing durable prepare/send/settle sequence and duplicate guards remain.
   Uncertain sends go to review and are never retried automatically. Approval
   changes invalidate pending/processing work without modifying sending intents.

`dashboard_active` chooses one enabled channel per business for availability
controls. The old single-channel fallback remains; multiple enabled channels with
no explicit choice fail closed. Chat selection lists only that channel's chats.

## Deployment and routing plan — not executed

1. Resolve the exact existing company WhatsApp account and its owner through a
   read-only Meta lookup. Existing screenshots/tool results contain conflicting
   account identifiers; do not choose an account from a guess. Confirm current
   callback/subscription state and whether another automation can still reply.
2. Confirm the Business app, required groups, and recovery/backup arrangements.
   Do not delete accounts, disconnect the app, register the number again, or remove
   an old provider merely because a trial expired.
3. Securely provision an IRAM-scoped deployment credential and the correct app
   secret. The temporary Explorer token shown in a screenshot is not a deployment
   credential. Do not print tokens or include them in this runbook or screenshots.
4. Review/apply the new migration and deploy the code with both pilot switches
   false. Keep the current test settings and AI reply mode unchanged.
5. Resolve the tenant that contains IRAM's approved knowledge and dashboard
   memberships. Bind the existing company number to that tenant with mode `pilot`,
   disabled, off, and a service-only authorization initially disabled. Use the same
   approved tester identities in deployment and database configuration. Do not
   copy customer data or assume the development business is IRAM's production tenant.
6. After explicit approval of the exact change, route **only this existing company
   number/account** to `/api/webhooks/whatsapp/pilot`. Inspect Meta's current
   per-number/account callback override support and save the prior configuration
   for reversal. Leave the shared IRAM app's AWS default callback and unrelated
   account subscriptions intact. If isolated routing is unavailable, stop and
   review the alternative; do not overwrite the shared callback.
7. Start receiving with deployment enabled, database receive approval and channel
   enabled, while both send switches remain false. Make this the dashboard's
   explicit active channel. Have approved testers send fresh individual messages.
8. In the existing dashboard choose **Selected chats only**, select Ziad and the
   employee chats, and save. Enable database sending, then deployment sending only
   for the approved pilot. A policy or availability change invalidates old work:
   send a fresh tester message afterward. Check one permitted reply, an unselected
   tester, an outsider, a paused chat, duplicate delivery and retained app/group
   use. Live sends require approval; local tests use synthetic data only.
9. Configure the separate pilot recovery schedule after deployment using
   `supabase/operations/configure-pilot-worker.sql`. Verify hosted delivery and
   recovery before calling the pilot live. This is independent of the existing
   development recovery schedule.

## Pause and recovery

Set deployment send enabled false and database `sending_enabled=false`; use
**Assistant off** in the dashboard. Preserve approval/binding rows and received
history. Do not delete the number, app, chats, subscriptions or authorization row
as a pause mechanism. An already prepared/in-flight send can still arrive, as the
dashboard already explains. With pilot receiving enabled, the worker can mark
expired send intents for review even while deployment sends are disabled.

The migration has no destructive down migration. A rollback disables the pilot
path and restores only the exact approved callback override, if one was changed.
The Business app and groups are never part of a reset procedure.

## Local validation

Run `npm run check`. Pilot tests exercise real migrations in an isolated PostgreSQL
runtime, synthetic signed webhooks and mocked HTTP. They cannot prove Meta access,
hosted RLS deployment, callback delivery, WhatsApp group preservation or billing.

## Read-only deployment review — 5 November 2026

The existing stable development deployment responds to health checks. Its pilot
route returns 404, so the new code has not been deployed. The app's saved database
has the existing development tenant, published IRAM knowledge, and one temporary
test-number channel; the pilot schema is not installed. The connected Supabase
plugin points to a different project and must not be used to apply this migration.

The Vercel CLI is currently logged out. No pilot Meta credentials are present in
local configuration. These access requirements must be resolved before a live
cutover can be prepared and verified. Do not use an unclaimed temporary Vercel
deployment as a workaround, change billing, or reuse the Explorer token.

The authenticated Meta Explorer's phone-number lookup exposes an application
callback on AWS, with no number/account override shown. The account subscription
check still reports that the company's messaging account is not subscribed to
the selected IRAM app. Keep the existing shared callback intact; a fresh,
authorized subscription/override inspection is required before changing routing.
