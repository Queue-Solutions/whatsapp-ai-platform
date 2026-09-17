# WhatsApp BSUID support

Protocol verified against [Meta's official business-scoped user ID documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids), updated August 24, 2026, read September 17, 2026.

## Supported behavior

- Incoming text/media envelopes accept an omitted `messages[].from` and `contacts[].wa_id`. The sender's `from_user_id` / contact `user_id` is used as the BSUID. Contacts are matched by exact phone/BSUID, never array position or username. Conflicting claims fail closed. Display names and usernames are optional.
- Outgoing text uses `to` for a phone and `recipient` for a BSUID. BSUID spelling/case is preserved. It is not a phone number, and never receives a `+` prefix. Delivery status still matches the provider message ID within the trusted channel even when no phone is present.
- A signed phone-plus-BSUID message links both identities to the existing customer and conversation. Later BSUID-only messages retain that history. New hidden-number customers have a NULL phone. Username changes affect presentation only, never identity.
- Inbox list and conversation header show the known phone below the name. Hidden-number customers show their username when available and “Phone number not shared.” The existing personal follow-up flow can collect a preferred callback number in text. That callback number is not an authenticated WhatsApp identity and never changes routing or approval.
- `system.type=user_changed_number` and `user_changed_user_id` update an already-known identity using the signed previous/new identifiers. Old aliases are retired, history is preserved, old pending generation is invalidated and no AI job is created. System changes do not extend the customer service window. Duplicate and stale changes cannot reapply an older identity.

## Test-only approval remains enforced

`WHATSAPP_TEST_RECIPIENTS` accepts comma-separated phone IDs or standard BSUIDs (`CC.` followed by 1–128 alphanumeric characters). New, unknown BSUID-only users must be explicitly approved. Existing approved phone recipients can use a BSUID only after a verified Meta webhook has established that exact alias in the same receiving channel. The webhook, database manual-send guard and final sender enforce this rule. An identity-change event preserves history but does not transfer approval from a retired phone/BSUID to a new number. The new identity must be explicitly approved unless it still has a current approved identifier.

Mappings are internal, service-role-only, tenant/channel scoped and protected by RLS plus composite foreign keys. Existing phone identifiers are backfilled from conversations. Username matching, phone guessing, caller-supplied destinations, and unverified callback details cannot establish aliases. If two already-existing customers have conflicting identifiers, ingestion fails rather than automatically combining their private histories. Resolve such conflicts through a reviewed data correction.

This release does not enroll parent-BSUID accounts, change a business number, import history, request a username or alter Meta contact-book settings. Standard portfolio BSUIDs remain available even for businesses enrolled in parent IDs. Parent-only routing, contact-card extraction and interactive phone-sharing buttons are not included. Existing text-based callback collection remains supported.

## Release and verification

Apply only `202609170003_bsuid.sql` after the earlier migrations, then deploy the matching app. Existing messages, FAQs and branches are retained. Old ingestion callers remain compatible during rollout. As with earlier SQL Editor releases, do not replay migrations or assume SQL Editor updated CLI migration history.

Run `npm run check`. Synthetic tests cover optional phone fields, malformed/conflicting identities, exact send fields, webhook signatures, phone/BSUID approval, durable duplicates, uncertain sends, tenant isolation, linked history, manual replies, restricted identity RPCs, and system changes. Do not send real customer messages as an automated test. Availability for an actual account depends on Meta's rollout and the configured test recipient permissions; synthetic protocol tests are not a live Meta delivery test.
