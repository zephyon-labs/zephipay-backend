# Payment Request beta contract

Payment Requests are authenticated, non-settling economic requests between two canonical ZephiPay accounts. Creation produces `pending`, never a receipt.

Public endpoints:

- `POST /api/payment-requests` — body `{ payerAccountId, amount, purpose? }`, plus `Idempotency-Key`.
- `GET /api/payment-requests?limit=20` — requester/payer-visible request activity.
- `GET /api/payment-requests/:id` — uniform participant-only read.
- `POST /api/payment-requests/:id/accept` — payer-only body `{ expectedVersion, trustAcknowledgment? }`.
- `POST /api/payment-requests/:id/decline` — payer-only body `{ expectedVersion }`.
- `POST /api/payment-requests/:id/cancel` — requester-only body `{ expectedVersion }`.

Acceptance creates or reuses one canonical payer-owned Payment Intent directed to the requester. It does not confirm or execute that intent. The payer must use the existing Payment Intent confirm and execute APIs. Canonical receipt insertion transitions the linked request from `accepted` to `paid` and records execution and receipt links.

Responses expose exact amounts as strings, nullable purpose, immutable participant snapshots, viewer role/direction, optimistic version, request hash, lifecycle timestamps, and public linkage IDs. They do not expose destinations, provider references, trust authority, rail choice, or settlement evidence.

Transfer is intentionally not implemented: the current account domain has no authoritative multiple-owned-source/destination model.
