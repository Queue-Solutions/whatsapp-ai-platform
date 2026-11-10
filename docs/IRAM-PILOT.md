# IRAM company-number pilot

## Current architecture

- IRAM keeps `+201200889966` in the WhatsApp Business app through Meta coexistence. The app, existing chats and groups are outside this platform's deletion or reset paths.
- Meta sends signed one-to-one message events to `/api/webhooks/whatsapp/pilot`. Group turns, phone-app echoes and history synchronization events are ignored.
- The exact Meta Phone Number ID and IRAM tenant are bound server-side. The dashboard never receives Meta credentials or chooses a tenant/channel from request input.
- The existing AI strategy, approved business knowledge, moderation, handoff, duplicate protection and uncertain-send handling are unchanged from the completed test phase.

## Dashboard operation

**Assistant off** is the safe default. Messages from approved testers still enter the inbox, but no automatic reply is prepared.

**Selected chats only** is the operational master switch. An owner or admin can approve an Egyptian mobile before that person messages IRAM. The platform canonicalizes `010…`, `+2010…`, `002010…`, Arabic digits and formatted variants to one `201…` identity. The first signed inbound message creates the conversation, attaches the prior approval and selects it automatically.

Removing a number stops future AI replies to that identity and invalidates pending generation. It does not block the person, delete the conversation, remove them from WhatsApp or affect groups.

## Independent safety gates

1. The Vercel deployment send switch is a hidden emergency ceiling and normally stays enabled once the pilot is approved. It is not edited per tester.
2. The service-only database authorization independently controls receiving and sending for the exact IRAM channel.
3. The dashboard independently controls whether the assistant is off or available to approved recipients.
4. Conversation pause, blacklist, moderation, the customer-service window and durable job leases still apply.
5. The final Meta sender rechecks the protected database approval immediately before every send. A database-prepared reply without that recheck is rejected.
6. Duplicate inbound IDs are durable. Network-uncertain sends go to review and are never automatically retried.

## Data boundary

Migration `20261110023000_iram_dashboard_recipients.sql` removes only obsolete Queue platform rows whose channel mode is `test`. It preserves the tenant, memberships, IRAM pilot conversations, customers still used by IRAM, FAQs, business facts, branches and AI configuration. It does not call Meta and cannot delete WhatsApp Business app chats, groups or the company number.

## Activation checklist

1. Run `npm run check` locally.
2. Review and apply the forward Supabase migration; never reset the database.
3. Deploy `main` with the existing IRAM credentials. Remove obsolete temporary-test-number environment values only after the new build is live.
4. Keep the assistant off. In the dashboard, approve the intended employee numbers and the Queue tester number.
5. Confirm each appears as “Waiting for first message,” then choose **Selected chats only** and save.
6. Send a fresh one-to-one message from each tester. Confirm the chat becomes “Chat connected” and receives exactly one appropriate reply.
7. Confirm an unapproved number receives no AI reply, a paused approved chat receives no AI reply, duplicate delivery creates no duplicate, and WhatsApp Business app/groups remain usable.

## Pause and recovery

Choose **Assistant off** for the normal pause. For an incident, also disable database sending and the deployment send ceiling. An already in-flight reply can still arrive. Do not deregister the number, disconnect coexistence, delete the app or clear WhatsApp chats as a pause mechanism.
