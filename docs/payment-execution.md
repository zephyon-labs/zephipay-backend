# Payment execution boundary

Payment Intent creation remains non-executing. Confirmation retains the v0.1 compatibility projection (`PROCESSING` and `executionStartedAt`) but now means only “confirmed and eligible”; `payment_executions.status` is the sole execution lifecycle authority.

`POST /api/payment-intents/:id/execute` authenticates and authorizes the owner, accepts only the persisted request hash/version, and creates or returns the intent’s unique execution. It never accepts rail, destination, provider, status, or evidence fields. `GET /api/payment-intents/:id/execution` returns a privacy-safe durable projection.

The backend hard-selects Mock Rail. Workers claim rows using database leases and `FOR UPDATE SKIP LOCKED`, persist `SUBMITTING` before provider contact, and use stable provider idempotency identity. A recovered `SUBMITTING`, `PROCESSING`, or `UNKNOWN` execution reconciles; it is never blindly resubmitted. Reconciliation observation sequence is durable.

The legacy `/api/send` endpoint always returns `410` and cannot be enabled by `PAYMENTS_ENABLED`. No canonical Solana adapter is registered, no Devnet RPC is contacted, and no real or Devnet funds can move through this pipeline.
