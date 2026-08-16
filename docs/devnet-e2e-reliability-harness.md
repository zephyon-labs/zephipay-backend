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

## Flow normalization

Actor shorthand is the stored classification and canonical payment flow is database-derived: `H2H→P2P`, `H2B→P2B`, `B2B→B2B`, `H2A→P2AI`, `A2H→AI2P`, `A2A→AI2AI`, and `A2B→AI2B`. The first canary is strictly human/H2H/P2P. Agent-direction scenarios remain unsupported even though their taxonomy is defined.

## Live canary boundary

Live policy is disabled by default. The policy gate requires an explicit live flag and confirmation, `solana-devnet`, at most 1000 raw USDC units, two `codex_e2e` synthetic actors, explicit submission and reconciliation capabilities, and no existing commitment. Mainnet fails closed. Once a commitment exists the execution is observation/reconciliation-only; signing and submission authority must not be reconstructed.

Provisioning requires an explicitly supplied public destination and never generates a wallet:

```sh
npm run e2e:devnet:provision
```

The destination relation means only “configured test destination”; it is not account ownership. The backend signer remains server-owned and neither synthetic actor receives custody.

Live operators use exactly one external, mode-0600 env file. The repository never searches for `.env` files and the helper does not evaluate the file as shell code. It accepts only the documented keys, rejects forensic/test database variables, validates the canonical local database and migration/actors without constructing providers, and passes the loaded environment to the same child process that launches the harness.

Readiness is provider-free and creates no payment:

```sh
npm run e2e:devnet:ready
```

The fixed path is `~/.zephipay/devnet/canary.env`; an operator may instead provide exactly one reviewed path with `-- --env-file /absolute/reviewed/path`. After separate transaction authorization, the live command is:

```sh
npm run e2e:devnet:live -- --scenario human-to-human-happy-path
```

Pure preflight completes before network-capable provider objects are constructed. Preparation is bounded to 30 seconds, reconciliation polls every 2 seconds for at most 120 seconds, and the intended overall operator window is 180 seconds. Timeout after commitment never enables resubmission; the durable execution remains reconciliation-only.

A run is inserted as `RUNNING` before economic work and terminalized as `PASSED` or `FAILED`. A process crash leaves `RUNNING`, never `PASSED`. Diagnose abandoned rows with a read-only query for `result='RUNNING'` ordered by `started_at`; inspect linked payment/execution and commitment state. If committed, restart only a reconciliation-capable, submission-disabled recovery path using the persisted signature.

Failure stages are `PRECONDITION_FAILED`, `IDENTITY_FAILED`, `PAYMENT_INTENT_FAILED`, `CONFIRMATION_FAILED`, `PREPARATION_FAILED`, `COMMITMENT_FAILED`, `SUBMISSION_REJECTED`, `SUBMISSION_AMBIGUOUS`, `RECONCILIATION_FAILED`, `SETTLEMENT_TIMEOUT`, `RECEIPT_FAILED`, `COMPLETION_FAILED`, and `INVARIANT_FAILED`.
