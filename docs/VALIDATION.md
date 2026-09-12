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

The successful tests used a local backend and temporary HTTPS tunnel. Vercel deployment and the Supabase recovery scheduler must be verified separately before claiming they work while the development machine is offline.
