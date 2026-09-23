# Foundation validation

## Semantic intent routing — 2026-09-23

The customer-language layer now uses a strict semantic classification call before business routing. The classifier receives no FAQ answers, returns only intent metadata and approved branch labels, and is cached against the current knowledge-catalog fingerprint. Workflow execution and all factual branch/link output remain deterministic and source-version guarded. Local resilience rules remain available only if classification cannot run.

Lint, TypeScript, all 323 automated tests and the production build passed. New synthetic coverage verifies misspelled human-contact and online-shopping requests, stale-history overrides, exact branch-record rendering, preservation of requested branch details, unresolved-branch clarification, corrected-query retrieval, strict classifier parsing, compact catalog disclosure and durable classification reuse. No paid OpenAI call, WhatsApp send, production deployment, database migration or client-number change was performed by this validation.

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

## Business knowledge editor — 2026-09-12

The `/dashboard` implementation passed lint, TypeScript, all 34 isolated tests and the production build. New coverage includes blank drafts versus approval, tenant/locale-scoped starter IDs, Google Maps URL validation, owner/viewer write permissions and cross-tenant knowledge isolation, save failure reporting, and defensive filtering of incomplete published records. Existing webhook authentication, duplicate processing and uncertain-send tests remain passing.

Browser review with an isolated local fixture confirmed blank branch fields, the Maps URL field, twelve starter FAQs and rejection of an incomplete branch approval. The temporary fixture route was removed before release. Real hosted Supabase password sign-in and owner membership/read access were verified using the publishable key and authenticated RLS. No business answers were seeded. Real browser save/reload acceptance with client-entered answers remains to be completed; database lifecycle tests cover draft persistence and approval.

## Bounded AI acceptance — 2026-09-12

Lint, TypeScript, all 57 automated tests and the production build passed; GitHub Actions also passed for the AI implementation and language correction. Added coverage exercises the actual PostgreSQL budget functions under concurrent requests, cross-tenant access, durable request reuse, uncertain provider outcomes, approved-source revision checks, human handoff, strict response validation and reply language. Existing webhook authentication, tenant isolation, duplicate-event and uncertain-send coverage remains passing.

Hosted acceptance used isolated fictional branch facts, without inserting business knowledge or sending WhatsApp messages. All ten version-two scenarios passed: English and Egyptian Arabic questions and paraphrases, missing prices, prompt injection, ambiguous branches, conversational follow-up, empty knowledge and explicit human requests. Eight scenarios called the model; empty knowledge and explicit human requests were handled locally. An initial version-one call answered an English question in Arabic, prompting an explicit output-language instruction, a language validation guard and a regression test before the final suite.

The hosted ledger recorded nine completed paid requests across both versions, with an estimated total charge of $0.0020768 against the shared, non-renewing $0.25 development allowance. There were no outstanding reservations. Replaying the completed English scenario returned a passing cached result with unchanged request count and allocation. This estimate uses full standard input pricing rather than cached-input discounts and is not an account billing report. No pending or processing messaging jobs were present before activation.

The release configuration switches `WHATSAPP_REPLY_MODE` to `ai` and disables `AI_ACCEPTANCE_ENABLED`. The key remains server-only in Vercel Production. Client FAQ answers and branch details were not seeded. A real WhatsApp AI round trip using client-approved dashboard content remains a separate acceptance step; the earlier real WhatsApp round trips verified echo messaging only.

## Greetings and human inbox — 2026-09-13

All 69 automated tests pass, including source-free social replies, mixed greeting/business questions, tenant-isolated inbox reads, role checks, stale mode changes, pause/resume invalidation of pending and in-flight AI work, allowlisted test-only manual replies, service-window checks, concurrent manual-request deduplication, delivery receipts arriving before send settlement, and uncertain-send recovery. The existing webhook, duplicate-event and tenant-isolation suites remain passing.

The inbox was reviewed at desktop and 390-pixel mobile widths using an isolated fictional browser fixture. Pause enabled the composer, a simulated manual send appeared with its status, and resume disabled the composer and restored assistant mode. This fixture was removed before release. No real WhatsApp messages or paid model calls were initiated during these checks. The forward inbox migration was applied once to the development database and verified without changing customer messages, approved knowledge or the AI allowance.

Actual client-entered knowledge already exists (five approved FAQ records at verification); this work preserved it. Existing recorded WhatsApp outcomes and the user's screenshot establish that branch/location answers have passed through the real bot. Live acceptance of the new greeting behavior and a human reply should use a fresh message from the approved personal recipient and the dashboard inbox. The simulated browser send does not establish actual Meta delivery for the new manual-send path.
