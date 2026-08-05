# Economic Identity and Recipient Directory

Phase B.2B adds an optional one-to-one Economic Identity record for a canonical account. Existing accounts are not backfilled and authentication never creates a username or public identity. New identities default to `PRIVATE`, `UNVERIFIED`, and `UNAVAILABLE`. Verification and payability are system-controlled states; the current-account API cannot assign them.

Usernames use an ASCII-first policy: 3–30 characters, beginning with a letter and followed only by letters, digits, or underscores. Lookup and uniqueness use the lowercase normalized username. Reserved platform names and values resembling internal identifiers or wallet addresses are rejected. Display names are trimmed, whitespace-normalized, non-unique, limited to 80 Unicode characters, and never used for lookup.

Solana destinations are canonical addresses linked to exactly one canonical account. Address uniqueness and one primary destination per account/type are enforced by PostgreSQL. Ownership defaults to `UNVERIFIED`; this phase provides no signature or ownership-proof mechanism.

Phase B.2C exposes authenticated exact-username search through `POST /api/recipients/search` and fresh re-resolution through `GET /api/recipients/:accountId`. Private, hidden, unavailable, restricted, self, and non-active recipients all fail closed. Search returns at most one result. The public projection contains only account ID, username, display name, account type, public verification state, payability state, and an optional HTTPS avatar URL. It never contains a wallet address, email, Auth0 data, actor subject, lifecycle status, allowlist state, internal versions, evidence, trust score, or history.

Recipient routes use the existing authenticated `read:account` policy and two dedicated in-process limits per 60 seconds: 30 requests per IP and 20 per canonical account. The account limit is lower so rotating network addresses does not bypass the authenticated-account boundary; the IP limit bounds aggregate activity. Queries are carried in POST bodies and are not written to normal application logs. Misses use an empty result for search and one uniform not-found response for resolution. A distributed limiter store is deferred until horizontally scaled deployment requires it.

`RecipientDirectoryService.resolvePaymentDestination` is backend-only. It revalidates account state, public resolvability, payability, and an active primary non-rejected destination. It does not create Payment Intents, execute payments, call Solana, or call the Zephyon Runtime.
