# Authenticated payment intents — Phase A

The durable `payments` aggregate is the only application payment-intent source
of truth. Phase A adds authenticated create, actor-owned read, and explicit
confirmation APIs around that aggregate. It does not add another table or
lifecycle.

Verified Auth0 issuer and subject are resolved through the canonical account
service. Only the resulting `zp:account:<uuid>` actor subject is authoritative.
Create and confirm additionally require an existing, enabled, unrevoked, and
unexpired Friends & Family allowlist entry. Historical actor-owned reads remain
available after beta access expires. Email, identity headers, account IDs, and
wallet addresses supplied by clients never establish sender authority.

## HTTP contracts

- `POST /api/payment-intents` requires `write:payments` and an
  `Idempotency-Key`. It creates `AWAITING_CONFIRMATION`; replaying the same
  actor/key/request returns the existing intent, while changed input conflicts.
- `GET /api/payment-intents/:id` requires `read:payments`. Missing and
  cross-account IDs both return not found.
- `POST /api/payment-intents/:id/confirm` requires `write:payments`, the stored
  request hash, and expected version. It atomically transitions to `PROCESSING`
  and appends `USER_CONFIRMED`. Matching retries return the canonical state
  without another transition.

All responses are private and uncached. Raw amounts and versions are decimal
strings. The API never accepts client-selected actor, rail, network, asset, or
mint values.

In this bounded phase, `PROCESSING` means confirmed and durably ready for a
future execution worker. Confirmation is deliberately disconnected from the
Zephyon Runtime, Solana, `payservice.ts`, and all external adapters. A later
execution port/outbox must consume confirmed durable records before settlement
is enabled. The legacy `/api/send` route remains untouched and payments remain
disabled by default.

Auth0 must grant `read:payments` and `write:payments` for these routes. The
environment names are `AUTH0_READ_PAYMENTS_SCOPE` and
`AUTH0_WRITE_PAYMENTS_SCOPE`, with those values as defaults.
