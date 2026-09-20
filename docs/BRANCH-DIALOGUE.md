# Branch navigation and conversation continuations

The assistant asks whether the customer wants jewelry or BTC/bullion before branch navigation when their product choice is unknown. A greeting also asks this question. The latest explicit customer choice takes precedence over earlier choices. Assistant offers do not count as customer choices.

Jewelry directories display branch names and saved cities, followed by an invitation to select a branch. The branch editor now includes an optional city field; existing JSON branch records remain valid. Missing cities are not invented. For an unambiguous selected jewelry branch, the application returns its saved address and map link directly. Multiple branches in a city stay a directory. Missing map links are acknowledged explicitly.

BTC availability and service hours come from approved FAQs. Retrieval prioritizes those FAQs and omits general branch hours from model-visible branch records for BTC questions. Addresses come from branch records when the customer requests a selected branch's location. Directory requests hide addresses, phones and map links from model-visible branch records. BTC branch lists and selected-branch details are rendered directly from a validated FAQ catalog, without model generation. Other BTC model requests exclude general directory FAQs and branch records outside that catalog.

Short replies accepting an offer resolve against the last assistant turn before retrieval. An acceptance of online links returns the relevant approved website/social links directly when available; an acceptance of branch help enters product routing. Contact collection does not treat online-shopping replies, common confirmations or known branch selections as names. History keeps a contiguous recent window of up to 16 messages and 9,000 UTF-8 bytes instead of skipping long replies and substituting older context.

The request byte ceiling is 22,000, below the existing 24,000 input-token allowance. Knowledge selection still checks the actual serialized request. The 650-token output allowance and durable reservations remain unchanged. Structured output limits prose to 1,000 characters, branch lines to 160 characters, and citations to supplied source labels. Link validation compares complete normalized approved URLs and handles Markdown delimiters and sentence punctuation.

The sidebar Blacklist indicator counts pending and kept blocks using authenticated membership RLS, fetching no message content. It refreshes every ten seconds, on window focus, and after a blacklist review. Removed blocks do not count; failed count requests show an unavailable indicator.

Read-only test-channel diagnostics on 2026-09-20 found four incomplete model responses, all using the full 650 output tokens, eleven invalid-source decisions and four unsupported-link decisions among the latest 108 AI requests. These counts identify failure categories, not the exact screenshot messages. No message bodies were read for these diagnostics. Regression tests use synthetic business records and conversation examples.

This change needs no SQL migration. It preserves existing chats, send deduplication, ambiguous-send handling, tenant isolation, test-number restrictions and the AI allowance. Hosted rollout and new test-number conversations are required to verify the changed model behavior in the running service.


## BTC continuity and silent recovery (2026-09-20)

Colloquial `سبايك` normalizes to `سبائك` throughout intent detection and branch routing. When the customer's recent context is BTC, asking for branches continues that choice instead of asking for jewelry/BTC again. BTC directories open with “لو بتسأل على السبائك، فدي الفروع المتاحة لخدمة BTC:” and retain FAQ-specific hours.

Technical failures never create customer-facing technical-error messages, including cached fallback decisions from earlier deployments. Recoverable model/network/validation failures get one additional internal attempt, with a shorter response instruction and a separate durable `:recovery:1` reservation. Both attempts retain normal budget accounting and source/link validation. Permanent authorization failures, exhausted budgets and still-running reservations do not retry. WhatsApp sends and uncertain send outcomes are never retried by this mechanism.

After failed recovery, the existing lease-validated suppress RPC terminally skips the job without creating an outbound row. The repository records `ai_reply_unavailable` on that job and flags eligible conversations for dashboard review through tenant-, automation-epoch-, mode- and attention-state-filtered metadata updates. Active complaints, existing reviews and human takeovers are preserved. These metadata writes follow the suppression transaction; a database failure there can leave the job suppressed without a new dashboard flag, while the AI attempt remains in the durable ledger. New customer messages can still use the assistant. No new SQL migration or grant change is required.


## Enforced BTC branch catalog

The approved FAQ question “What information can you provide about your bullion or BTC products?” is preferred as the BTC catalog source. Its displayed position (question 8) is not used as an ID. Branch eligibility and the BTC-specific phone come exclusively from its `Branch name: phone` rows; service hours come from its BTC hours line. Names and phone numbers are read afresh for each reply, not hardcoded. Other branches in the menu cannot expand this list.

BTC directory replies are built directly from these rows with one introduction, one selection instruction, and no street addresses, map links or phone directory. A selected branch combines the FAQ's BTC phone/hours with the uniquely matching branch-menu address/mapsUrl. Name matching supports case/spacing, parenthetical location suffixes, and identity aliases such as Korba/Corba and Mansoura/MANS. A shared city does not establish a branch identity. Missing or ambiguous address matches are disclosed while preserving the confirmed BTC phone; another branch's address is never substituted.

Malformed or conflicting catalogs require a knowledge review instead of falling back to the jewelry directory. Multiple candidate catalogs must agree on the branch-to-phone mapping. Source IDs and versions accompany every deterministic reply for the existing pre-send tenant/publication checks. The rest of the model pipeline retains bounded recovery, while BTC directory/detail replies need no paid model call. No database migration is required.
