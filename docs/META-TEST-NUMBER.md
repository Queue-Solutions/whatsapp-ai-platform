# First real WhatsApp echo

The first real English and Arabic echo flow was verified on 2026-09-12; see `VALIDATION.md`. Automated tests alone do not establish success for a new client or deployment.

## Get the development credentials

1. Create a Meta developer app with the WhatsApp use case/product. Open its API setup/testing area and use the **Meta-provided temporary test number**. UI wording can vary by account.
2. Add and verify your own WhatsApp number as an allowed test recipient in Meta. Do not add, migrate, register or deregister the client's existing number.
3. Copy the temporary test Phone Number ID (not the displayed phone number or WABA ID), temporary access token, and the Graph API version shown in Meta's example request into `.env.local`.
4. Copy the Meta App Secret from the app's basic settings. It is different from the access token and webhook verification token.
5. Set `WHATSAPP_TEST_RECIPIENTS` to your verified recipient WhatsApp ID, digits with country code, no `+` or spaces. Comma-separate multiple verified recipients.
6. Generate separate random secrets for `WHATSAPP_VERIFY_TOKEN` and `CRON_SECRET` (at least 16 and 32 characters respectively). Set `WHATSAPP_MODE=test`.
7. Run `npm run setup:test-tenant`. This maps the temporary number to the Queue Solutions development tenant. It does not call Meta or touch any phone account.

## Connect the webhook

1. Run the app on localhost and expose it using a trusted HTTPS development tunnel, or deploy a dedicated development environment on Vercel. Configure server environment values there; do not publish secrets in the repository. The webhook URL must be publicly reachable by Meta without an interactive login.
2. Set the callback URL to `https://YOUR_DEVELOPMENT_HOST/api/webhooks/whatsapp` and enter the matching `WHATSAPP_VERIFY_TOKEN`.
3. Subscribe to WhatsApp `messages` events and ensure the app is subscribed to the test WABA. A verified GET callback alone does not enable inbound delivery. Follow the current Meta panel instructions for your app.
4. Send a real text from your verified personal recipient to the **temporary Meta number**. A user-initiated message establishes the customer service window for an echo.
5. Check Supabase: one customer, one open conversation, an inbound and outbound message, and a completed job. Wait for the echo on your phone; delivery receipts update the outbound record.
6. Send an Arabic text as well. Confirm the text is preserved and echoed correctly.

Configure a scheduler to call `GET /api/internal/process-messages` with `Authorization: Bearer <CRON_SECRET>` at least every minute for low-volume tests, or run `npm run worker:once` manually during local testing. Each call handles one job. Verify your hosting plan's scheduler frequency before relying on it. `after()` is a latency optimization; pending jobs remain stored if the function stops.

## Additional checks

- `npm run smoke:webhook` signs a synthetic webhook twice with the same event ID. It is localhost-only and **can send one actual echo** to the first approved recipient. Send a real WhatsApp message first so the service window is open. This simulation cannot prove that Meta accepts your webhook subscription.
- `npm run worker:once` drains one pending job using the protected endpoint.
- Set the test conversation's `automation_mode` to `human` in Supabase, send a fresh message, and confirm it is stored without an echo. Return it to `auto` to resume new-message replies. Already skipped messages are not replayed.
- Review jobs in `failed` or `needs_review`. Do not automate retries for uncertain sends.

## Troubleshooting

- Verification 403: mismatched verify token or missing subscribe/challenge parameters.
- POST 403: missing/incorrect signature or App Secret; never disable signature checks to make it work.
- POST 503: incomplete environment, unavailable database, unapplied migration, or missing channel mapping.
- Webhook verified but no inbound: confirm `messages` subscription, test WABA app subscription, current test recipient and correct temporary number.
- Stored inbound but no reply: inspect job state, worker schedule, handoff mode, test allowlist and channel enablement.
- Meta 401/403: the temporary access token may have expired or lack required permissions. In the initial development setup, numeric code 131005 persisted despite the token reporting the correct app, scopes, and WABA targets; regenerating the token in Try it out and restarting the backend resolved it. Do not assume displayed scopes prove messaging access.
- Meta 400: check the test recipient, phone ID, API version and service window in the Meta dashboard. Provider-specific details are deliberately excluded from application logs.

Record the real test date, inbound provider ID, outbound provider ID, and observed phone receipt in `docs/VALIDATION.md` once completed. No real end-to-end success should be claimed before then.
