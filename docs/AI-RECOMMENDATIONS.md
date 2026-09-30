# AI recommendations

The AI recommendations page shows the tenant's current FAQ opportunities and recurring complaint themes. It does not expose a client-selected time range. Analytics keeps its independent date controls and historical report/export behavior.

Recommendations are derived from persisted, bounded message insights and approved FAQs. They are not copied into a mutable recommendation table. The sidebar indicator polls the small current-recommendations RPC every ten seconds, refreshes on window focus and after a reset, and displays the total current count across the signed-in user's RLS-visible business memberships. It fetches no customer message bodies.

Owner and admin members can use **Reset** after confirming the action. Reset stores a tenant-scoped cutoff and immediately makes every current recommendation disappear. It does not delete chats, messages, insights, FAQs or historical analytics. Only customer activity after the cutoff can produce a fresh recommendation, so the badge returns only when a genuinely new current recommendation qualifies. Other tenant roles can view recommendations but cannot reset them.

Migration `202609300003_ai_recommendation_reset.sql` creates the protected cutoff table plus member-read and owner/admin-reset RPCs. Existing tenant isolation and RLS remain enforced.
