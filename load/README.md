# R4 local capacity harness

This harness is local-only. It runs the compiled production backend against a fresh PostgreSQL database and deterministic Mock execution. It must never target Railway or a shared database.

The five k6 scenarios are `read-baseline`, `authenticated-session`, `payment-lifecycle`, `concurrent-payment-safety`, and `mixed-workload`. R4 harness validation is restricted to Stage 0 and a tiny smoke run. Later stages require separate approval.

Authentication uses an ephemeral RSA key supplied directly to the backend module by the local orchestrator under `NODE_ENV=test`. There is no environment, header, query, or HTTP fault/auth switch.

Fault tests use only disposable-database lifecycle control, held pool clients, direct SQL locks and transaction-local timeouts, child-process SIGTERM, repository decorators, and existing Mock scenarios. Every write/fault scenario must run `verifyEconomicInvariants` afterward.

Run `npm run r4:stage0` or `npm run r4:smoke` with `R4_ADMIN_DATABASE_URL` pointing to a local administrative PostgreSQL database. k6 must be installed separately. Output is written below `.artifacts/r4/`, which is gitignored.
