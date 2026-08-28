# Phase C durable receipts and activity

Canonical Phase C receipts are stored in `payment_execution_receipts`. They are
rail-independent Runtime receipt records and are intentionally separate from the
legacy Solana-shaped `payment_receipts` table and the process-local x402 receipt
registry.

The x402 preview system is experimental and noncanonical. `X402_ENABLED`
defaults to `false`; while it is unset or false, its middleware, facilitator
client, process-local receipt registry, agent resource, verification, listing,
entitlement, catalog, and protocol-description routes are not mounted.
`SVM_ADDRESS` is required only when `X402_ENABLED=true`. Enabling x402 does not
make its preview objects Zephyon settlement evidence, canonical receipts, or
economic authority.

The Mock-only worker creates a Runtime v0.2 receipt only from a conclusive
`settled` observation. PostgreSQL commits the `SETTLED` execution update, its
attempt, `execution_settled` event, canonical receipt, and `receipt_created`
event in one transaction. The receipt ID is stable per execution and database
uniqueness plus append-only triggers enforce idempotency and immutability. The
ordered migration backfills any Batch 1 Mock executions that were already
settled so an upgrade cannot retain settled state without a receipt.

Authenticated contracts (all require `read:payments` and an active canonical
account) are:

- `GET /api/payment-intents/:id/receipt` returns the owner's privacy-safe receipt.
- `GET /api/payment-intents/:id/execution` returns the authoritative frontend projection.
- `GET /api/activity?limit=20` returns sender-private history ordered by Payment Intent creation time. Limits are 1–50.

Payment purpose is optional descriptive context. Omitted, `null`, empty, and
whitespace-only creation values normalize to canonical `null` before hashing
and persistence. Payment Intent, receipt (`memo`), and activity (`memo`)
projections return `null` when absent; they never invent placeholder text.

Missing and cross-account receipt/execution records return the same not-found
response. Activity is derived from Payment Intents, executions, and receipts;
there is no mutable activity mirror. Recipient display data always comes from
the immutable Payment Intent snapshot.

Internal-to-public execution status mapping:

| Internal | Public |
| --- | --- |
| `READY` | `ready` |
| `SUBMITTING` | `processing` |
| `PROCESSING` | `processing` |
| `UNKNOWN` | `pending` |
| `SETTLED` | `settled` |
| `FAILED` | `failed` |
| `CANCELLED` | `cancelled` |

`UNKNOWN` also returns `reconciliationPending: true` and never projects as a
failure. Failure details use bounded public codes and messages. Provider
idempotency keys, leases, raw evidence, internal failures, reconciliation
references, and actor subjects are never returned.

Solana remains unregistered. `PAYMENTS_ENABLED` does not alter the Mock-only
worker, and `/api/send` remains permanently disabled with HTTP 410.
