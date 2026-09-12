# Foundation validation

Verified on 2026-09-12:

- Lint, TypeScript, and Next.js production build passed.
- All 27 automated PostgreSQL, webhook, and scheduler tests passed, covering tenant isolation, signatures, duplicates, handoff suppression, leases, ambiguous send outcomes, delivery-status ordering, and conditional scheduler requests.
- GitHub Actions passed on a clean Linux runner.
- Hosted Supabase schema: 10 tables with RLS, 13 policies, and 6 backend-only worker functions. Anonymous table access and browser execution of worker functions are blocked.
- Meta test channel and approved recipient were configured, and the application was subscribed to the test WABA.
- Real English and Arabic inbound messages reached the webhook, were persisted, and generated automatic replies. Both jobs completed; Meta delivery receipts confirmed both replies were delivered, preserving the original text.
- Initial Meta error 131005 was resolved by refreshing test-account authorization and restarting the backend. Displayed scopes alone did not prove successful messaging access.
- Two synthetic diagnostic inbounds were recorded separately from real inbound tests. The first failed; the refreshed-token diagnostic succeeded. Failed attempts were not blindly replayed.
- The client's live number and existing chats were not connected or modified.

Detailed operational identifiers remain in local/private records and the development database.

The initial round trips used a local backend and temporary HTTPS tunnel. Subsequent real English and Arabic messages passed through the hosted Vercel callback on 2026-09-12: both jobs completed in one attempt and both replies received delivery receipts. The public health route returned 200, an unsigned webhook returned 403, and an unauthenticated worker returned 401. An authenticated worker returned 200 with an empty queue. The generated deployment address remained protected (302 login redirect). Supabase Cron is active every minute and has recorded successful executions. A request from Supabase using the Vault-held worker credential returned HTTP 200 with an empty queue. After stopping the local Next.js server and Cloudflare tunnel, one synthetic recovery diagnostic was inserted into the queue without invoking a local or webhook worker. The next scheduled Supabase request returned HTTP 200 with a sent result; the job completed in one attempt and its single outbound reply received a delivered receipt. The diagnostic reused the most recent real inbound timestamp and did not extend the customer service window.
