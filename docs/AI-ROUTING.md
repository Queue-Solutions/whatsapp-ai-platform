# Semantic AI routing

Customer-language understanding and business execution are separate layers.

1. Durable messaging validates the tenant, channel, assistant mode, service window, duplicate identity and moderation result.
2. An in-progress contact workflow is continued deterministically so names and phone numbers are never guessed by a model.
3. The semantic classifier reads the latest message, bounded history, FAQ questions and the approved branch name/city catalog. It returns strict JSON containing intent, confidence, corrected query, language, product, requested branch detail and branch labels. It receives no FAQ answers and cannot send a message.
4. The backend validates every returned branch label against the current tenant-scoped catalog. High-confidence workflow intents are executed locally: human follow-up, complaints, approved links, careers, repairs, social replies and exact branch records.
5. General business questions use the corrected query for hybrid exact/fuzzy retrieval. The answer model receives the original message, interpreted request and selected approved records. Every factual answer must cite current source versions.
6. Before sending, the database rechecks the job lease, automation epoch, human takeover, recipient allowlist and source publication timestamps.

The classifier is the primary natural-language layer. Existing phrase detectors remain only as an outage/budget fallback and must not authorize business facts. Classification is cached under a tenant-scoped message identity plus a catalog fingerprint, so duplicate processing cannot produce a new interpretation and changed knowledge cannot reuse a stale catalog decision.

Two model calls are possible for a general FAQ: compact semantic classification, then grounded answer generation. Deterministic workflow intents normally require only classification. Each call has its own durable usage reservation. Answer-generation failures keep the existing two silent recovery attempts; a failed classifier falls back conservatively instead of being repeatedly charged.

Safety boundaries intentionally remain deterministic:

- assistant availability and human takeover
- blacklist policy and moderation counters
- tenant/RLS resolution
- webhook authentication and deduplication
- send allowlists and uncertain-send handling
- approved URL validation
- exact branch addresses, maps and BTC eligibility
- contact detail collection and persistence
- source revision checks immediately before send

This architecture improves misspelling and intent handling without giving a probabilistic model authority to invent facts or perform irreversible actions.
