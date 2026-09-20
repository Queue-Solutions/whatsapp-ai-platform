# Queue Solutions WhatsApp platform

- Before creating a different project folder, ask the user where it belongs. Keep this project in its existing user-selected directory.
- Read docs/CLIENT-CHAT-PRESERVATION.md before any WhatsApp account or number work. Preserving the client's old chats is mandatory.
- Only Meta's temporary test number is authorized in this foundation. Do not onboard or alter the client number.
- Never print credentials, access tokens, raw webhook payloads, or customer message bodies in logs.
- Keep business logic independent of Next.js route handlers; resolve tenants from trusted channel mappings or authenticated membership.
- Do not bypass the send allowlist, database grants, RLS, or durable deduplication.
- Run npm run check after substantive changes. Tests must cover tenant isolation, webhook authentication, duplicate events, and uncertain send outcomes.
- After pushing requested fixes to GitHub, leave Vercel deployment verification to the user unless they explicitly ask for it.
