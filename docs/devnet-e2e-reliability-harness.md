# Devnet E2E reliability harness

The harness classifies canonical accounts through `synthetic_test_actors`; it never changes what an account means. `synthetic-human-a` and `synthetic-human-b` are provisioned through the canonical identity repository under `NODE_ENV=test`, use no reusable credentials, and are the only durable actor fixtures. Agent vocabulary is reserved, but agent rows are not provisioned.

Runs are recorded in `e2e_test_runs` and move once from `RUNNING` to `PASSED`, `FAILED`, or `UNSUPPORTED`. Terminal rows and actor classification are immutable. Public human Open Beta telemetry excludes source accounts present in `synthetic_test_actors`; the durable executions remain available to operational and internal QA telemetry. This table is also the reusable exclusion boundary for future ZP, ZTS, rewards, referrals, and ZERA eligibility. Those systems are not implemented here.

## Offline commands

Apply migrations 001–019 to a disposable database and set `TEST_DATABASE_URL`. Normal invocation is offline and uses deterministic in-process signer, blockhash, submission, and reconciliation boundaries:

```sh
npm run e2e:devnet -- --scenario human-to-human-happy-path
npm run e2e:devnet -- --suite reliability-v1
```

Runnable H2H scenarios are `human-to-human-happy-path`, `duplicate-confirm`, `duplicate-execute`, `refresh-after-execute`, `recover-after-ambiguous-response`, `restart-after-commit`, `reconciliation-recovery`, `receipt-idempotency`, and `payment-completion-idempotency`.

`human-to-agent`, `agent-to-human`, and `agent-to-agent` are `UNSUPPORTED`. Depending on direction, the missing primitives are an authenticated agent principal, agent-owned account authorization, payable agent identity and destination authorization, and execution API authorization. The harness does not fabricate them.

## Live canary boundary

Live policy is disabled by default. The policy gate requires an explicit live flag and confirmation, `solana-devnet`, at most 1000 raw USDC units, two `codex_e2e` synthetic actors, explicit submission and reconciliation capabilities, and no existing commitment. Mainnet fails closed. Once a commitment exists the execution is observation/reconciliation-only; signing and submission authority must not be reconstructed.

The first live canary must be separately reviewed and composed with environment-owned signer and provider configuration. This implementation does not execute it and the default CLI rejects `--live-devnet` before constructing provider infrastructure.
