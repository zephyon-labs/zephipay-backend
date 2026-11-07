/** Actual PostgreSQL suite. Opt-in only; missing/unsafe designation is a failure, never a skip. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { NativeSessionCore } from "../src/nativeSession/core";
import { NativeCredentialPolicy } from "../src/nativeSession/policy";
import { PostgresNativeSessionPersistence } from "../src/nativeSession/postgresPersistence";
import { PostgresIdentityPersistence } from "../src/storage/postgres/postgresIdentityPersistence";
import { attemptId, bindingReference, proofCommitment } from "../src/nativeSession/values";
import {
  ACCESS,
  CLIENT,
  REVOCATION,
  SyntheticAuthentication,
} from "./helpers/nativeSessionHarness";
import { nativeDisposableTarget, verifyNativeDisposable } from "./helpers/nativePostgresSafety";
import { waitForPostgresPast } from "./helpers/postgresClock";

const target = nativeDisposableTarget(process.env);
const pool = new Pool(target.pool);
before(async () => {
  await verifyNativeDisposable(pool, target, false);
  for (const [file, version] of [
    ["migrations/002_identity_foundation.sql", "002_identity_foundation.sql"],
    ["sql/candidates/native-session-postgres-v1.sql", "candidate_native_session_postgres_v1.sql"],
  ]) {
    const checksum = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    assert.equal(
      (
        await pool.query("SELECT checksum FROM public.payment_schema_migrations WHERE version=$1", [
          version,
        ])
      ).rows[0]?.checksum,
      checksum,
    );
  }
});
after(() => pool.end());
async function now() {
  return Number(
    (await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now"))
      .rows[0].now,
  );
}
async function until(check: () => Promise<boolean>) {
  const stop = process.hrtime.bigint() + 5_000_000_000n;
  while (process.hrtime.bigint() < stop) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail("Bounded PostgreSQL observation expired");
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
type Hook = (sql: string, client: PoolClient, result?: unknown) => Promise<void>;
function instrument(beforeQuery?: Hook, afterQuery?: Hook) {
  const pids: number[] = [];
  const source = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      pids.push(Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
      return {
        query: async (sql: string, values?: unknown[]) => {
          await beforeQuery?.(sql, client);
          const result = await client.query(sql, values);
          await afterQuery?.(sql, client, result);
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy),
      } as unknown as PoolClient;
    },
  } as Pick<Pool, "query" | "connect">;
  return { source, pids };
}
async function seed() {
  const accountId = randomUUID(),
    subject = `native-fixture:${randomUUID()}`,
    identity = new PostgresIdentityPersistence(pool);
  const started = await now();
  await identity.provisionExternalIdentity({
    accountId,
    identityId: randomUUID(),
    issuer: CLIENT.issuer,
    subject,
    occurredAt: new Date(started - 60_000).toISOString(),
  });
  const createdAt = await now(),
    id = randomUUID().replaceAll("-", ""),
    reference = bindingReference(`binding_${id}`),
    attempt = attemptId(`attempt_${id}`);
  const context = {
      environment: CLIENT.environment,
      issuer: CLIENT.issuer,
      clientId: CLIENT.clientId,
      audience: CLIENT.audience,
    },
    creationKey = id.repeat(2),
    challenge = "33".repeat(32);
  await pool.query(
    `INSERT INTO native_session_candidate.bindings(binding_reference,login_attempt_id,environment,issuer,client_id,audience,creation_key,challenge,access_commitment,revocation_commitment,
    created_at_ms,attempt_expires_at_ms,last_observed_at_ms,attempt_state,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$11,'PENDING','PENDING')`,
    [
      reference,
      attempt,
      context.environment,
      context.issuer,
      context.clientId,
      context.audience,
      creationKey,
      challenge,
      proofCommitment("access", { context, creationKey }, ACCESS),
      proofCommitment("revocation", { context, creationKey }, REVOCATION),
      createdAt,
      createdAt + 300_000,
    ],
  );
  const auth = new SyntheticAuthentication(),
    policy = new NativeCredentialPolicy(auth, [CLIENT]);
  const evidence = (at: number, bootstrap = true, changes: Record<string, unknown> = {}) =>
    auth.issue({
      issuer: CLIENT.issuer,
      subject,
      azp: CLIENT.clientId,
      audience: [CLIENT.audience],
      scopes: [...CLIENT.scopes],
      issuedAt: at - 1000,
      expiresAt: at + 299_000,
      grant: bootstrap ? "authorization_code" : "refresh_token",
      ...(bootstrap ? { bootstrap: { version: 1, loginAttemptId: attempt, challenge } } : {}),
      ...changes,
    });
  const core = (source: Pick<Pool, "query" | "connect"> = pool, lifetime = 86_400_000) =>
    new NativeSessionCore(new PostgresNativeSessionPersistence(source), policy, lifetime);
  const complete = async (c = core(), proof?: object) =>
    c.complete({
      loginAttemptId: attempt,
      accessSecret: ACCESS,
      evidence: proof ?? evidence(await now()),
    });
  const validate = async (c = core(), proof?: object) =>
    c.validate({
      nativeBindingReference: reference,
      accessSecret: ACCESS,
      evidence: proof ?? evidence(await now(), false),
    });
  const revoke = (c = core()) =>
    c.revoke({ nativeBindingReference: reference, revocationSecret: REVOCATION });
  const stored = async () =>
    (
      await pool.query(
        "SELECT * FROM native_session_candidate.bindings WHERE binding_reference=$1",
        [reference],
      )
    ).rows[0];
  const version = async () =>
    BigInt(
      (await pool.query("SELECT version FROM public.accounts WHERE account_id=$1", [accountId]))
        .rows[0].version,
    );
  return {
    accountId,
    subject,
    reference,
    attempt,
    createdAt,
    evidence,
    core,
    complete,
    validate,
    revoke,
    stored,
    version,
  };
}

test("real connections serialize duplicate completion/revocation and retain canonical effects", async () => {
  const f = await seed(),
    observed = instrument(),
    core = f.core(observed.source);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.complete(core)));
  assert.ok(results.every((r) => r.kind === "account-access"));
  assert.equal(
    new Set(results.map((r) => r.kind === "account-access" && r.canonicalAccountSessionId)).size,
    1,
  );
  assert.ok(new Set(observed.pids).size > 1);
  assert.equal(await f.version(), 2n);
  const revoked = await Promise.all(Array.from({ length: 8 }, () => f.revoke(core)));
  assert.ok(revoked.every((r) => r.kind === "terminal" && r.state === "REVOKED"));
  assert.equal(await f.version(), 3n);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT event_type,count(*)::int AS count FROM public.account_security_events WHERE account_id=$1 AND event_type::text LIKE 'SESSION_%' GROUP BY event_type ORDER BY event_type",
        [f.accountId],
      )
    ).rows,
    [
      { event_type: "SESSION_CREATED", count: 1 },
      { event_type: "SESSION_REVOKED", count: 1 },
    ],
  );
});

for (const first of ["complete", "cancel", "validate", "revoke"] as const)
  test(`actual blocked concurrent transaction: ${first} obtains binding lock first`, async () => {
    const f = await seed();
    if (first === "validate" || first === "revoke") await f.complete();
    const held = latch(),
      release = latch();
    let paused = false;
    const observed = instrument(undefined, async (sql) => {
      if (
        !paused &&
        sql.includes("FROM native_session_candidate.bindings") &&
        sql.endsWith("FOR UPDATE")
      ) {
        paused = true;
        held.release();
        await release.promise;
      }
    });
    const core = f.core(observed.source);
    const a =
      first === "complete"
        ? f.complete(core)
        : first === "validate"
          ? f.validate(core)
          : f.revoke(core);
    let second: ReturnType<typeof f.complete> | undefined;
    try {
      await Promise.race([
        held.promise,
        a.then(() => {
          throw new Error("First operation finished before reaching the binding lock");
        }),
      ]);
      const b = (second =
        first === "complete" || first === "validate"
          ? f.revoke(core)
          : first === "cancel"
            ? f.complete(core)
            : f.validate(core));
      await until(
        async () =>
          observed.pids.length >= 2 &&
          (
            await pool.query("SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked", [
              observed.pids[0],
              observed.pids[1],
            ])
          ).rows[0].blocked,
      );
      release.release();
      const [left, right] = await Promise.all([a, b]);
      if (first === "complete" || first === "validate") assert.equal(left.kind, "account-access");
      else assert.equal(left.kind, "terminal");
      assert.equal(right.kind, "terminal");
      assert.equal((await f.stored()).state, first === "cancel" ? "CANCELLED" : "REVOKED");
      assert.equal((await f.complete()).kind, "terminal");
    } finally {
      release.release();
      await Promise.all([a, second]);
    }
  });

test("FOR UPDATE account lock conflicts with KEY SHARE before the canonical session is locked", async () => {
  const f = await seed();
  await f.complete();
  const stored = await f.stored();
  const holder = await pool.connect(),
    probe = await pool.connect(),
    observed = instrument();
  let pending: ReturnType<typeof f.validate> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT account_id FROM public.accounts WHERE account_id=$1 FOR KEY SHARE", [
      f.accountId,
    ]);
    pending = f.validate(f.core(observed.source));
    await until(
      async () =>
        observed.pids.length > 0 &&
        (
          await pool.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [
            observed.pids[0],
          ])
        ).rows[0].blocked,
    );
    await probe.query("BEGIN");
    await assert.rejects(
      () =>
        probe.query(
          "SELECT binding_reference FROM native_session_candidate.bindings WHERE binding_reference=$1 FOR UPDATE NOWAIT",
          [f.reference],
        ),
      (e: unknown) => (e as { code: string }).code === "55P03",
    );
    await probe.query("ROLLBACK");
    await probe.query("BEGIN");
    await probe.query(
      "SELECT session_id FROM public.account_sessions WHERE session_id=$1 FOR UPDATE NOWAIT",
      [stored.canonical_session_id],
    );
    await probe.query("ROLLBACK");
    await holder.query("ROLLBACK");
    assert.equal((await pending).kind, "account-access");
  } finally {
    await holder.query("ROLLBACK");
    await probe.query("ROLLBACK");
    holder.release();
    probe.release();
    await pending;
  }
});

test("canonical mutation and native transition roll back on a real database statement failure", async () => {
  const f = await seed();
  let updates = 0;
  const observed = instrument(async (sql, client) => {
    if (sql.startsWith("UPDATE native_session_candidate.bindings") && ++updates === 2)
      await client.query("SELECT 1/0");
  });
  assert.equal((await f.complete(f.core(observed.source))).kind, "unavailable");
  assert.equal((await f.stored()).state, "PENDING");
  assert.equal(await f.version(), 1n);
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM public.account_sessions WHERE account_id=$1", [
        f.accountId,
      ])
    ).rows[0].count,
    "0",
  );
  assert.equal((await f.complete()).kind, "account-access");
});

test("terminal response waits for acknowledged COMMIT; injected response loss recovers committed revocation", async () => {
  const f = await seed();
  await f.complete();
  let lose = true;
  const observed = instrument(undefined, async (sql) => {
    if (sql === "COMMIT" && lose) {
      lose = false;
      throw new Error("Injected acknowledgement loss after real commit");
    }
  });
  assert.equal((await f.revoke(f.core(observed.source))).kind, "unavailable");
  assert.equal((await f.stored()).state, "REVOKED");
  assert.equal(await f.version(), 3n);
  assert.equal((await f.revoke()).kind, "terminal");
  assert.equal(await f.version(), 3n);
});

test("actual PostgreSQL-observed expiry persists and refreshed credentials do not renew it", async () => {
  const f = await seed();
  const result = await f.complete(f.core(pool, 1200));
  assert.equal(result.kind, "account-access");
  if (result.kind !== "account-access") throw new Error("fixture");
  const observation = await waitForPostgresPast(pool, new Date(result.expiresAt).toISOString());
  assert.ok(Date.parse(observation.observed) > result.expiresAt);
  assert.equal((await f.validate()).kind, "terminal");
  assert.equal((await f.stored()).state, "EXPIRED");
  assert.equal((await f.complete()).kind, "terminal");
  assert.equal(await f.version(), 2n);
});

test("controlled expiry-equality sample persists a real watermark and subsequent earlier database time is denied", async () => {
  const f = await seed();
  await f.complete();
  const expiry = (await now()) + 60_000;
  const original = instrument();
  const controlled = {
    ...original.source,
    connect: async () => {
      const c = await original.source.connect();
      return {
        query: (sql: string, values?: unknown[]) =>
          sql.includes("clock_timestamp()")
            ? c.query("SELECT $1::text AS observed", [String(expiry)])
            : c.query(sql, values),
        release: c.release.bind(c),
      } as unknown as PoolClient;
    },
  } as Pick<Pool, "query" | "connect">;
  const evidence = f.evidence(expiry - 299_000, false); // Exact expiry, inside the allowed 5-minute lifetime.
  assert.deepEqual(await f.validate(f.core(controlled), evidence), {
    kind: "rejected",
    code: "ACCESS_TOKEN_EXPIRED",
  });
  assert.equal((await f.stored()).last_observed_at_ms, String(expiry));
  assert.equal((await f.validate(f.core(), evidence)).kind, "unavailable");
  // This is a controlled result substitution, not a claim that PostgreSQL's wall clock was changed.
});

test("connection termination rolls back a waiting transaction and yields unavailable authority", async () => {
  const f = await seed(),
    holder = await pool.connect(),
    observed = instrument();
  let pending: ReturnType<typeof f.complete> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT * FROM native_session_candidate.bindings WHERE binding_reference=$1 FOR UPDATE",
      [f.reference],
    );
    pending = f.complete(f.core(observed.source));
    await until(
      async () =>
        observed.pids.length > 0 &&
        (
          await pool.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [
            observed.pids[0],
          ])
        ).rows[0].blocked,
    );
    await pool.query("SELECT pg_terminate_backend($1)", [observed.pids[0]]);
    assert.equal((await pending).kind, "unavailable");
    await holder.query("ROLLBACK");
    assert.equal((await f.stored()).state, "PENDING");
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    await pending;
  }
});

test("candidate schema rejects identity changes, unknown states, deletion and watermark reversal", async () => {
  const f = await seed();
  await f.complete();
  for (const set of [
    "state='UNSUPPORTED'",
    "attempt_state='PENDING'",
    "owner_subject='other'",
    "creation_key=repeat('f',64)",
    "last_observed_at_ms=created_at_ms-1",
    "state='PENDING'",
    "state='REVOKED'",
  ])
    await assert.rejects(() =>
      pool.query(`UPDATE native_session_candidate.bindings SET ${set} WHERE binding_reference=$1`, [
        f.reference,
      ]),
    );
  await assert.rejects(() =>
    pool.query("DELETE FROM native_session_candidate.bindings WHERE binding_reference=$1", [
      f.reference,
    ]),
  );
  assert.equal((await f.validate()).kind, "account-access");
});

test("malformed driver record after a real SELECT cannot change canonical identity", async () => {
  const f = await seed();
  let calls = 0;
  const observed = instrument(undefined, async (sql, _client, result) => {
    if (sql.includes("FROM public.accounts")) {
      const r = result as { rows: object[] };
      r.rows[0] = new Proxy(r.rows[0], {
        get() {
          calls++;
          return "substitution";
        },
      });
    }
  });
  assert.equal((await f.complete(f.core(observed.source))).kind, "unavailable");
  assert.equal(calls, 0);
  assert.equal(await f.version(), 1n);
  assert.equal((await f.stored()).state, "PENDING");
});

test("native mutations change the captured account-version predicate used for pending Web eligibility", async () => {
  const f = await seed(),
    captured = await f.version();
  assert.equal((await f.complete()).kind, "account-access");
  assert.equal(
    (
      await pool.query(
        "SELECT version=$2::bigint AS eligible FROM public.accounts WHERE account_id=$1",
        [f.accountId, captured.toString()],
      )
    ).rows[0].eligible,
    false,
  );
  const next = await f.version();
  await f.revoke();
  assert.equal(
    (
      await pool.query(
        "SELECT version=$2::bigint AS eligible FROM public.accounts WHERE account_id=$1",
        [f.accountId, next.toString()],
      )
    ).rows[0].eligible,
    false,
  );
  // The full economic_confirmation_summary view / Web recovery ceremony is NOT installed or claimed by this minimal fixture.
});

function worker(input: unknown): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "tests/helpers/nativePostgresRecoveryWorker.ts"],
      { env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout });
    });
    child.stdin.end(JSON.stringify(input));
  });
}
test("new application process recovers after a prior process exits following real commit", async () => {
  const f = await seed();
  const exited = await worker({
    reference: f.reference,
    subject: f.subject,
    action: "exit-after-commit",
  });
  assert.equal(exited.code, 73);
  assert.equal(exited.stdout, "");
  const stored = await f.stored(),
    recovered = await worker({ reference: f.reference, subject: f.subject, action: "validate" });
  assert.equal(recovered.code, 0);
  const result = JSON.parse(recovered.stdout).result;
  assert.equal(result.kind, "account-access");
  assert.equal(result.canonicalAccountSessionId, stored.canonical_session_id);
  assert.equal(await f.version(), 2n);
});

test("native account access creates no economic objects or capabilities", async () => {
  const f = await seed(),
    result = await f.complete();
  assert.equal(result.kind, "account-access");
  if (result.kind !== "account-access") throw new Error("fixture");
  assert.equal(result.economicAuthority, "unavailable");
  assert.deepEqual(
    (
      await pool.query(
        "SELECT to_regclass('public.economic_session_bindings') AS binding, to_regclass('public.economic_consent_evidence') AS consent, to_regclass('public.payments') AS payment",
      )
    ).rows[0],
    { binding: null, consent: null, payment: null },
  );
});
