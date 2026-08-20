# Growth and ZP projection activation

The Growth and ZP projection worker is an optional, downstream materialization
pipeline. Both phases default off and can be stopped independently without
changing payment or settlement truth.

## Preconditions

- PostgreSQL is enabled and migrated through migration 021.
- The deployed backend contains the Growth/ZP projection worker.
- Normal payment execution, settlement, and receipt persistence are healthy.
- Aggregate reliability metrics and logs are available to operators.

## Safe enablement

Stage 1 projects durable settled receipts into append-only Growth events:

```text
GROWTH_PROJECTION_ENABLED=true
ZP_PROJECTION_ENABLED=false
```

Observe `growth_zp_projection.iteration` and
`growth_zp_projection.schedule`. Successful iterations followed by idle
scheduling indicate that the bounded backlog is converging. Repeated failure
outcomes require investigation before proceeding.

Stage 2 enables ZP materialization after Growth is healthy:

```text
GROWTH_PROJECTION_ENABLED=true
ZP_PROJECTION_ENABLED=true
```

Observe successful iterations, eventual idle scheduling, and authenticated
`GET /api/account/zp` results for controlled beta accounts. Projection
freshness does not participate in application readiness.

## Rollback and kill switches

Either phase can be disabled independently by setting its flag to `false` and
restarting the backend. Disabling projection does not delete Growth events or
ZP state, alter payments or receipts, grant submission authority, or change
settlement behavior. Re-enabling resumes from durable Growth and ZP cursors.

Do not place database credentials, provider secrets, or signing material in
this runbook. Environment activation remains a separate operator action.
