# Job enquiries and blacklist review

## Job enquiries

Arabic and English job enquiries, including “محتاج شغل”, enter a dedicated flow before business-knowledge retrieval. The assistant asks for the desired role first, then the applicant's name and contact number. The confirmation promises contact **only if the role is needed**. It does not invent vacancies or promise a response time.

The Inbox shows the desired role, contact details and a Job enquiry reason. Completing the details pauses the assistant for personal review. Existing human takeovers remain paused. A new business question can leave contact collection and use normal knowledge handling.

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

Run `npm run check`. Tests cover job collection and conditional confirmation, selected moderation categories, image retrieval restrictions, failed checks, authenticated previews, tenant isolation, duplicate events, blocked manual/automatic sends, BSUID continuity, unblocking without backlog replay, and stale in-flight verdicts. Existing signature and uncertain-send tests remain in the full suite. Provider results and media are simulated in tests, with no live customer messages or paid API calls.
