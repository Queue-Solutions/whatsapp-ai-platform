# Branch navigation and conversation continuations

The assistant asks whether the customer wants jewelry or BTC/bullion before branch navigation when their product choice is unknown. A greeting also asks this question. The latest explicit customer choice takes precedence over earlier choices. Assistant offers do not count as customer choices.

Jewelry directories display branch names and saved cities, followed by an invitation to select a branch. The branch editor now includes an optional city field; existing JSON branch records remain valid. Missing cities are not invented. For an unambiguous selected jewelry branch, the application returns its saved address and map link directly. Multiple branches in a city stay a directory. Missing map links are acknowledged explicitly.

BTC availability and service hours come from approved FAQs. Retrieval prioritizes those FAQs and omits general branch hours from model-visible branch records for BTC questions. Addresses come from branch records when the customer requests a selected branch's location. Directory requests hide addresses, phones and map links from model-visible branch records. The prompt requires BTC branch names and distinct BTC service hours without full addresses, and BTC directory answers must cite a BTC FAQ.

Short replies accepting an offer resolve against the last assistant turn before retrieval. An acceptance of online links returns the relevant approved website/social links directly when available; an acceptance of branch help enters product routing. Contact collection does not treat online-shopping replies, common confirmations or known branch selections as names. History keeps a contiguous recent window of up to 16 messages and 9,000 UTF-8 bytes instead of skipping long replies and substituting older context.

The request byte ceiling is 22,000, below the existing 24,000 input-token allowance. Knowledge selection still checks the actual serialized request. The 650-token output allowance and durable reservations remain unchanged. Structured output limits prose to 1,000 characters, branch lines to 160 characters, and citations to supplied source labels. Link validation compares complete normalized approved URLs and handles Markdown delimiters and sentence punctuation.

The sidebar Blacklist indicator counts pending and kept blocks using authenticated membership RLS, fetching no message content. It refreshes every ten seconds, on window focus, and after a blacklist review. Removed blocks do not count; failed count requests show an unavailable indicator.

Read-only test-channel diagnostics on 2026-09-20 found four incomplete model responses, all using the full 650 output tokens, eleven invalid-source decisions and four unsupported-link decisions among the latest 108 AI requests. These counts identify failure categories, not the exact screenshot messages. No message bodies were read for these diagnostics. Regression tests use synthetic business records and conversation examples.

This change needs no SQL migration. It preserves existing chats, send deduplication, ambiguous-send handling, tenant isolation, test-number restrictions and the AI allowance. Hosted rollout and new test-number conversations are required to verify the changed model behavior in the running service.
