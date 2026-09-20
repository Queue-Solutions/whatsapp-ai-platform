# Job enquiries and blacklist review

## Job enquiries

Arabic and English job enquiries, including “محتاج شغل”, are answered directly from the approved job-vacancy FAQ currently displayed as FAQ 9. The assistant returns that saved answer and its HR contact instructions on the first message. It does not ask for a desired role, name or phone number, create an application follow-up, invent vacancies or substitute model-written application guidance.

FAQ display positions are editable, so runtime matching uses the approved job-vacancy question rather than a hardcoded row number. Existing database fields for the retired application-collection workflow remain for backward compatibility, but the assistant ignores a legacy in-progress career form and uses normal knowledge handling.

## Reply scope

Hiring phrases such as “مش محتاجين عمالة؟”, CV/resume wording and affirmative replies to an old hiring clarification use the approved FAQ without a paid generation request. If the bounded model classifies less common recruitment phrasing as a career enquiry, the application discards its prose and substitutes the approved FAQ answer.

Unrelated questions exclude branch facts and directory FAQs from retrieval. A request scope also constrains branchLines in the structured response. Final and cached replies are checked for unsolicited listings, including known branch names/addresses in prose. Specific hours/payment questions remain concise rather than opening the directory. Invalid business source references are still rejected.

## Blacklist

The sidebar's Blacklist page has Needs review, Kept blocked and Unblocked lists. A new automated flag immediately blocks dashboard/assistant replies for that customer. The admin can inspect the reason and original message, keep the block, or remove it. Image previews require an authenticated, tenant-scoped request and an explicit Reveal image click. The original message and review history are retained.

Blocks follow the internal customer, including verified phone/BSUID changes. They are application blocks, not changes to the customer's WhatsApp account. Removing a block restores eligibility for **new** messages using the existing conversation mode. It never replays the blocked backlog, resumes an existing human takeover, or retries an uncertain send. A send already in flight cannot be recalled.

## Content checks

New text messages, image captions and images use OpenAI's free `omni-moderation-latest` endpoint with the existing server-side `OPENAI_API_KEY`. The paid response model and its budget do not change. Only sexual content, sexual content involving minors, harassment, harassment/threatening, hate and hate/threatening trigger blocks. Other categories, personal information and ordinary complaints are not a blacklist policy.

The provider supports sexual-content classification for images. Harassment and hate/threat categories are text-only, so those checks cover message text and captions, not reliable OCR or all threatening scenes in images. Automated assessments can be wrong and are presented as reviewable flags, not established facts. See [OpenAI moderation guide](https://developers.openai.com/api/docs/guides/moderation).

Images are retrieved from Meta using a validated numeric media ID, test Phone Number ID, authenticated requests, allowed Meta CDN hosts, no redirects, timeouts and a 5 MB bound. Image bytes are transient and sent as inline data to the moderation endpoint. No downloaded image, raw moderation response, credential or customer body is logged. Only the original caption, media ID, verdict, selected categories and evidence reference are persisted. Previews may become unavailable when Meta expires the media. See [Meta's media download reference](https://www.postman.com/meta/whatsapp-business-platform/request/zsq66eh/download-media).

A provider/download/configuration failure pauses the affected conversation and adds **Content check needs review** to Inbox. It does not label the customer abusive or create a blacklist entry. Review the message before returning the assistant to the conversation. Existing messages are not scanned retrospectively.

## Deployment and verification

Apply `202609170004_careers_blacklist.sql` before deploying this code. It adds fields/tables and replaces guarded procedures without deleting customers, messages, branches or FAQs. New ingest and moderation procedures are service-only. Browser users retain RLS-scoped reads, and only owners/admins can review blocks with a current revision.

Run `npm run check`. Tests cover direct job-FAQ answers, selected moderation categories, image retrieval restrictions, failed checks, authenticated previews, tenant isolation, duplicate events, blocked manual/automatic sends, BSUID continuity, unblocking without backlog replay, and stale in-flight verdicts. Existing signature and uncertain-send tests remain in the full suite. Provider results and media are simulated in tests, with no live customer messages or paid API calls.
