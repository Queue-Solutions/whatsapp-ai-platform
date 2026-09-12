# Client chat preservation — mandatory project constraint

The client must retain existing WhatsApp chats and access to their existing WhatsApp Business app.

- Development uses Meta's temporary test number and approved test recipients only.
- Never reset, delete, deregister, migrate, or register the client's existing number through a destructive flow.
- Never run number-registration or migration calls against the client as part of testing.
- Before any future onboarding, verify current Meta Coexistence eligibility for the specific account and number. If unavailable, stop that onboarding path; do not fall back to a migration that loses chats or app access.
- Confirm the client's current chat backup and recovery arrangements before onboarding. A backup is an additional precaution, not permission to delete anything.
- Review the exact Coexistence provider flow and its limitations with the client before enabling it.
- Preserving chats in the Business app and importing historical chats into our dashboard are separate requirements. Do not promise that the complete historical archive will appear in this platform.

This repository cannot prove from a Phone Number ID alone that Meta issued it as a test number. A developer must confirm it in Meta's test-number panel. Both environment configuration and database channel mode enforce test-only operation; there is no live-mode switch in v1.
