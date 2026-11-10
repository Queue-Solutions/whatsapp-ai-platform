# Client chat preservation — mandatory project constraint

The client must retain existing WhatsApp chats and access to their existing WhatsApp Business app.

- IRAM uses its existing WhatsApp Business app and company number through the already established coexistence connection.
- Never reset, delete, deregister, migrate, or register the client's existing number through a destructive flow.
- Never run number-registration or migration calls against the client as part of testing.
- Before any future onboarding, verify current Meta Coexistence eligibility for the specific account and number. If unavailable, stop that onboarding path; do not fall back to a migration that loses chats or app access.
- Confirm the client's current chat backup and recovery arrangements before onboarding. A backup is an additional precaution, not permission to delete anything.
- Review the exact Coexistence provider flow and its limitations with the client before enabling it.
- Preserving chats in the Business app and importing historical chats into our dashboard are separate requirements. Do not promise that the complete historical archive will appear in this platform.

Deleting obsolete Queue test-channel records is permitted only when it is scoped to this platform's Supabase rows. It must never delete or alter the client's WhatsApp app chats, groups, number registration or coexistence connection.
