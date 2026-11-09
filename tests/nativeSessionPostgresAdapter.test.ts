import { postgresAddressProjectionFixture } from "./helpers/postgresAddressProjectionFixture";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import type { Binding, SessionTransaction } from "../src/nativeSession/contracts";
import { NativeSessionCore } from "../src/nativeSession/core";
import { PostgresNativeSessionPersistence } from "../src/nativeSession/postgresPersistence";
import { nativeDisposableTarget, verifyNativeDisposable } from "./helpers/nativePostgresSafety";
import {
  ACCESS,
  ACCOUNT,
  fixture,
  OTHER_ACCOUNT,
  REVOCATION,
  START,
} from "./helpers/nativeSessionHarness";

function databaseBinding(b: Binding) {
  return {
    loginAttemptId: b.loginAttemptId,
    nativeBindingReference: b.nativeBindingReference,
    ...b.context,
    creationKey: b.creationKey,
    challenge: b.challenge,
    accessCommitment: b.accessCommitment,
    revocationCommitment: b.revocationCommitment,
    createdAt: String(b.createdAt),
    attemptExpiresAt: String(b.attemptExpiresAt),
    lastObservedAt: String(b.lastObservedAt),
    attemptState: b.attemptState,
    state: b.state,
    ownerSubject: b.owner?.subject ?? null,
    accountId: b.owner?.accountId ?? null,
    canonicalAccountSessionId: b.canonicalAccountSessionId ?? null,
  };
}

/** SQL transcript simulation only. It does NOT establish SQL syntax, constraints, locks or durability. */
async function transcript(active = true) {
  const f = fixture();
  if (active) await f.complete();
  const snapshot = f.memory.snapshot(),
    b = snapshot.bindings.get(f.b.nativeBindingReference)!;
  let binding = databaseBinding(b),
    committed = structuredClone(binding);
  let a = {
    account_id: ACCOUNT,
    actor_subject: `zp:account:${ACCOUNT}`,
    status: "ACTIVE",
    version: active ? "1" : "0",
    created_at: new Date(START),
    updated_at: new Date(START),
  };
  let s = {
    session_id: b.canonicalAccountSessionId as string,
    account_id: ACCOUNT,
    created_at: new Date(START),
    expires_at: new Date(START + 86_400_000),
    revoked_at: null as Date | null,
  };
  const queries: string[] = [],
    releases: boolean[] = [];
  const controls = {
    fail: "",
    committedLoss: false,
    transform: (_kind: string, row: unknown) => row,
    before: null as null | ((sql: string) => Promise<void>),
  };
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
    if (controls.before) await controls.before(sql);
    if (controls.fail && sql.includes(controls.fail)) throw new Error("Injected query failure");
    let rows: unknown[] = [];
    if (sql.startsWith("COMMIT")) {
      committed = structuredClone(binding);
      if (controls.committedLoss) {
        controls.committedLoss = false;
        throw new Error("Injected lost acknowledgement");
      }
    } else if (sql === "ROLLBACK") binding = structuredClone(committed);
    else if (sql.startsWith("SELECT binding_reference"))
      rows = [{ reference: f.b.nativeBindingReference }];
    else if (sql.includes("FROM native_session_candidate.bindings"))
      rows = [controls.transform("binding", structuredClone(binding))];
    else if (sql.includes("FROM public.external_identities")) rows = [{ accountId: ACCOUNT }];
    else if (sql.includes("FROM public.accounts"))
      rows = [
        controls.transform("account", {
          accountId: a.account_id,
          actorSubject: a.actor_subject,
          status: a.status,
          version: a.version,
          updatedAt: String(a.updated_at.getTime()),
        }),
      ];
    else if (sql.includes("FROM public.account_sessions"))
      rows = [
        controls.transform("session", {
          canonicalAccountSessionId: s.session_id,
          accountId: s.account_id,
          createdAt: String(s.created_at.getTime()),
          expiresAt: String(s.expires_at.getTime()),
          revokedAt: s.revoked_at ? String(s.revoked_at.getTime()) : null,
        }),
      ];
    else if (sql.includes("clock_timestamp()")) rows = [{ observed: String(f.memory.now) }];
    else if (sql.startsWith("UPDATE native_session_candidate.bindings")) {
      binding = {
        ...binding,
        lastObservedAt: String(params[1]),
        state: params[2] as Binding["state"],
        attemptState: params[3] as Binding["attemptState"],
        ownerSubject: params[4] as string | null,
        accountId: params[5] as string | null,
        canonicalAccountSessionId: params[6] as NonNullable<
          Binding["canonicalAccountSessionId"]
        > | null,
      };
      rows = [controls.transform("saved", structuredClone(binding))];
    }
    // Existing canonical helpers execute these statements on the SAME leased client.
    else if (sql.startsWith("SELECT * FROM accounts")) rows = [a];
    else if (sql.includes("INSERT INTO account_sessions")) {
      s = {
        session_id: params[0] as string,
        account_id: params[1] as string,
        created_at: new Date(params[2] as string),
        expires_at: new Date(params[3] as string),
        revoked_at: null,
      };
      rows = [s];
    } else if (sql.includes("UPDATE account_sessions")) {
      s = { ...s, revoked_at: new Date(params[2] as string) };
      rows = [s];
    } else if (sql.includes("UPDATE accounts SET version")) {
      a = {
        ...a,
        version: String(BigInt(a.version) + 1n),
        updated_at: new Date(params[1] as string),
      };
      rows = [a];
    } else if (sql.includes("INSERT INTO account_security_events"))
      rows = [
        {
          event_id: "1",
          account_id: ACCOUNT,
          sequence_number: 1,
          event_type: params[1],
          account_version: a.version,
          session_id: s.session_id,
          identity_id: null,
          details: {},
          occurred_at: a.updated_at,
        },
      ];
    else if (!sql.startsWith("BEGIN") && !sql.startsWith("SET LOCAL"))
      throw new Error(`Unexpected transcript statement: ${sql}`);
    return { rows, rowCount: rows.length };
  };
  const client = {
    query,
    release: (destroy = false) => releases.push(destroy),
  } as unknown as PoolClient;
  const pool = { query, connect: async () => client } as unknown as Pick<Pool, "query" | "connect">;
  const persistence = new PostgresNativeSessionPersistence(pool),
    core = new NativeSessionCore(persistence, f.policy, 86_400_000);
  return {
    f,
    controls,
    client,
    pool,
    persistence,
    core,
    queries,
    releases,
    binding: () => committed,
    complete: () =>
      core.complete({
        loginAttemptId: f.b.loginAttemptId,
        evidence: f.evidence,
        accessSecret: ACCESS,
      }),
    validate: () =>
      core.validate({
        nativeBindingReference: f.b.nativeBindingReference,
        evidence: f.evidence,
        accessSecret: ACCESS,
      }),
    revoke: () =>
      core.revoke({
        nativeBindingReference: f.b.nativeBindingReference,
        revocationSecret: REVOCATION,
      }),
  };
}

test("adapter transcript uses binding -> exclusive account -> exclusive session -> database clock on one client", async () => {
  const t = await transcript();
  assert.equal((await t.validate()).kind, "account-access");
  const at = (text: string) => t.queries.findIndex((q) => q.includes(text));
  assert.ok(at("FROM native_session_candidate.bindings") < at("FROM public.accounts"));
  assert.ok(at("FROM public.accounts") < at("FROM public.account_sessions"));
  assert.ok(at("FROM public.account_sessions") < at("clock_timestamp()"));
  assert.ok(
    t.queries
      .filter((q) =>
        /FROM (public.accounts|public.account_sessions|native_session_candidate.bindings)/.test(q),
      )
      .every((q) => q.endsWith("FOR UPDATE")),
  );
  assert.equal(t.queries.at(-1), "COMMIT");
  assert.deepEqual(t.releases, [false]);
});

test("adapter composes existing canonical creation/revocation helpers without a second client", async () => {
  const t = await transcript(false);
  assert.equal((await t.complete()).kind, "account-access");
  assert.equal((await t.revoke()).kind, "terminal");
  assert.equal((await t.revoke()).kind, "terminal");
  assert.equal(t.queries.filter((q) => q.includes("INSERT INTO account_sessions")).length, 1);
  assert.equal(t.queries.filter((q) => q.includes("UPDATE account_sessions")).length, 1);
  assert.equal(
    t.queries.filter((q) => q.includes("INSERT INTO account_security_events")).length,
    2,
  );
});

for (const failure of [
  "FOR UPDATE",
  "clock_timestamp()",
  "UPDATE native_session_candidate.bindings",
  "COMMIT",
])
  test(`transcript ${failure} failure yields unavailable authority and discards the connection`, async () => {
    const t = await transcript();
    t.controls.fail = failure;
    assert.equal((await t.validate()).kind, "unavailable");
    assert.equal(t.queries.at(-1), "ROLLBACK");
    assert.deepEqual(t.releases, [true]);
  });

test("transcript lost COMMIT acknowledgement never returns a false denial acknowledgement", async () => {
  const t = await transcript();
  t.f.memory.now += 300_000;
  t.controls.committedLoss = true;
  assert.equal((await t.validate()).kind, "unavailable");
  assert.equal(t.binding().lastObservedAt, String(START + 300_000));
  t.f.memory.now--;
  assert.equal((await t.validate()).kind, "unavailable");
});

for (const kind of ["binding", "account", "session", "saved"])
  test(`malformed ${kind} driver row is rejected without trusting accessors`, async () => {
    const t = await transcript();
    let calls = 0;
    t.controls.transform = (which, row) =>
      which === kind
        ? new Proxy(row as object, {
            get() {
              calls++;
              throw new Error("read");
            },
          })
        : row;
    assert.equal((await t.validate()).kind, "unavailable");
    assert.equal(calls, 0);
  });

test("wrong account from PostgreSQL cannot replace the resolved canonical account", async () => {
  const t = await transcript(false);
  t.controls.transform = (kind, row) =>
    kind === "account"
      ? {
          ...(row as object),
          accountId: OTHER_ACCOUNT,
          actorSubject: `zp:account:${OTHER_ACCOUNT}`,
        }
      : row;
  assert.equal((await t.complete()).kind, "unavailable");
  assert.ok(!t.queries.some((q) => q.includes("INSERT INTO account_sessions")));
});

for (const version of ["-1", "1.5", "1e3", "9223372036854775808"])
  test(`malformed database bigint ${version} is rejected`, async () => {
    const t = await transcript();
    t.controls.transform = (kind, row) =>
      kind === "account" ? { ...(row as object), version } : row;
    assert.equal((await t.validate()).kind, "unavailable");
  });

test("escaped transaction methods cannot run after release", async () => {
  const t = await transcript();
  let escaped!: SessionTransaction;
  await t.persistence.transaction(t.f.b.nativeBindingReference, async (tx) => {
    escaped = tx;
  });
  const count = t.queries.length;
  await assert.rejects(() => escaped.observeTime());
  assert.equal(t.queries.length, count);
});

test("caught operation errors poison the transaction instead of committing partial work", async () => {
  const t = await transcript();
  await assert.rejects(() =>
    t.persistence.transaction(t.f.b.nativeBindingReference, async (tx) => {
      await assert.rejects(() =>
        tx.lockSession(
          t.f.memory.snapshot().bindings.get(t.f.b.nativeBindingReference)!
            .canonicalAccountSessionId!,
        ),
      );
      return "caller attempted success";
    }),
  );
  assert.ok(!t.queries.includes("COMMIT"));
});

test("concurrent methods and unawaited operations cannot escape transaction rollback", async () => {
  for (const concurrent of [false, true]) {
    const t = await transcript();
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    t.controls.before = async (sql) => {
      if (sql.includes("FROM public.accounts")) await hold;
    };
    const result = t.persistence.transaction(t.f.b.nativeBindingReference, async (tx) => {
      void tx.lockAccount(ACCOUNT).catch(() => {});
      if (concurrent) void tx.binding().catch(() => {});
      queueMicrotask(release);
    });
    await assert.rejects(() => result);
    assert.ok(!t.queries.includes("COMMIT"));
    assert.equal(t.queries.at(-1), "ROLLBACK");
  }
});

const designation = {
  NATIVE_SESSION_TEST_DATABASE: "zephipay_native_session_test_0123456789abcdef",
  NATIVE_SESSION_TEST_PORT: "55432",
  NATIVE_SESSION_TEST_CONFIRM: "DISPOSABLE_LOCAL_NATIVE_SESSION_V1",
};
test("disposable configuration ignores ambient application and PG connection settings", () => {
  const target = nativeDisposableTarget({
    ...designation,
    DATABASE_URL: "postgres://cloud.invalid/live",
    TEST_DATABASE_URL: "postgres://cloud.invalid/shared",
    PGHOST: "cloud.invalid",
    PGUSER: "production",
    PGPASSWORD: "not-used",
  });
  assert.equal(target.pool.host, "127.0.0.1");
  assert.equal(target.pool.user, "native_session_fixture");
  assert.equal(target.pool.password, "native-session-disposable-only");
  assert.equal(target.pool.connectionString, undefined);
});
for (const changes of [
  {},
  { NATIVE_SESSION_TEST_DATABASE: "postgres" },
  { NATIVE_SESSION_TEST_DATABASE: "zephipay" },
  { NATIVE_SESSION_TEST_PORT: "65536" },
  { NATIVE_SESSION_TEST_PORT: "5432?host=cloud.invalid" },
  { NATIVE_SESSION_TEST_CONFIRM: "" },
])
  test(`unsafe or missing database designation is rejected: ${JSON.stringify(changes)}`, () => {
    assert.throws(() =>
      nativeDisposableTarget(Object.keys(changes).length ? { ...designation, ...changes } : {}),
    );
  });

test("database identity and empty-target checks fail closed before mutation", async () => {
  const target = nativeDisposableTarget(designation);
  const safe = {
    database: target.database,
    username: "native_session_fixture",
    address: "127.0.0.1",
    port: target.port,
    version: 160006,
    recovery: false,
    marker: target.marker,
  };
  for (const changes of [
    { address: "10.0.0.1" },
    { marker: null },
    { database: "shared" },
    { username: "application" },
    { recovery: true },
    { port: 5432 },
    { version: 150010 },
  ]) {
    const calls: string[] = [];
    const pool = {
      query: async (sql: string) => {
        calls.push(sql);
        return {
          rows: [
            postgresAddressProjectionFixture(sql, { ...safe, ...changes }),
          ],
        };
      },
    } as unknown as Pick<Pool, "query">;
    await assert.rejects(() => verifyNativeDisposable(pool, target, true));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].startsWith("SELECT"));
  }
  const occupied = {
    query: async (sql: string) => ({
      rows: sql.includes("current_database()")
        ? [postgresAddressProjectionFixture(sql, safe)]
        : [{ count: "1" }],
    }),
  } as unknown as Pick<Pool, "query">;
  await assert.rejects(() => verifyNativeDisposable(occupied, target, true), /empty/);
});
