# Synthetic beta identities

`SYNTHETIC_BETA_IDENTITIES_ENABLED=true` permits authenticated, allowlisted testers to resolve bounded human-readable names when no canonical Economic Identity exists. It defaults to false, rejects malformed boolean values, and startup fails if authentication/PostgreSQL are unavailable or `PAYMENTS_ENABLED` is not explicitly false. The execution subsystem remains Mock-only; `/api/send` stays disabled and no Solana adapter is registered.

Canonical username resolution always runs first. Eligible misses are NFKC-normalized, trimmed, case-folded, and assigned a deterministic namespaced UUID. A dedicated `synthetic_beta_identities` table supports the existing two-step recipient-selection contract without creating accounts, Economic Identities, credentials, directory registrations, destinations, or verification records. Synthetic recipients are explicitly `UNVERIFIED` and marked `identitySource: SYNTHETIC_BETA`.

Synthetic Send uses the ordinary Payment Intent, confirmation, execution, Runtime SDK, Mock Rail worker, reconciliation, receipt, and activity pipeline. Its immutable snapshot and receipt preserve the entered display name and synthetic marker. Synthetic recipients are excluded from Recent Payment Identities. If a real username is registered later, future resolution returns the real identity while historical snapshots remain synthetic.

Synthetic Request is intentionally unsupported. `payment_requests.payer_account_id` requires a genuine canonical account, and synthetic actors cannot authenticate to accept or decline. Request creation rejects synthetic payer IDs rather than manufacturing account authority.

Before any real settlement rail is enabled for the public Personal flow, this flag **must be false**. A separately approved isolated sandbox may enable it only while Mock Rail is the sole execution adapter.
