/** OFFLINE ONLY: real pg.Client and accepted core/adapter; simulated connection messages, no socket/SQL server. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Client, type ClientConfig, type Pool, type PoolClient } from "pg";
import { NativeSessionCore } from "../../src/nativeSession/core";
import { PostgresNativeSessionPersistence } from "../../src/nativeSession/postgresPersistence";
import { ACCESS, ACCOUNT, START, fixture } from "./nativeSessionHarness";
import { instrumentNativePool } from "./nativePostgresInstrumentation";

const mode = process.env.NATIVE_PG_SIMULATED_CASE ?? "";
if (
  ![
    "legacy",
    "event-first",
    "query-first",
    "late",
    "query-only",
    "healthy",
    "ownership",
    "unexpected",
    "unarmed",
    "end-first",
    "pid-rejection",
    "late-unexpected",
    "cleanup-failure",
    "before-hook",
    "after-hook",
  ].includes(mode)
)
  throw new Error("Unknown simulated case");
const names: string[] =
  require("../../scripts/native-postgres-ci-reporter.cjs").CASE_NAMES;
const hostile = "SECRET_SENTINEL\n::error::forged\nhttps://secret.invalid/";
type Row = Record<string, unknown>;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function scenario() {
  const f = fixture();
  const initial: Row = {
    loginAttemptId: f.b.loginAttemptId,
    nativeBindingReference: f.b.nativeBindingReference,
    ...f.b.context,
    creationKey: f.b.creationKey,
    challenge: f.b.challenge,
    accessCommitment: f.b.accessCommitment,
    revocationCommitment: f.b.revocationCommitment,
    createdAt: String(f.b.createdAt),
    attemptExpiresAt: String(f.b.attemptExpiresAt),
    lastObservedAt: String(f.b.lastObservedAt),
    attemptState: "PENDING",
    state: "PENDING",
    ownerSubject: null,
    accountId: null,
    canonicalAccountSessionId: null,
  };
  let committed = {
    binding: initial,
    session: null as Row | null,
    version: "0",
    events: 0,
  };
  let working = structuredClone(committed);
  const clients: PoolClient[] = [],
    releases: boolean[] = [];
  const trace: string[] = [];
  const healthy = mode === "healthy" || mode === "ownership";
  const hookMode = mode === "before-hook" || mode === "after-hook";
  let failures = healthy || hookMode ? 0 : 1;
  let hookFault = hookMode;
  const foreign = () => {
    trace.push("foreign-error");
  };
  let before = 0,
    after = 0;
  let instrument: ReturnType<typeof instrumentNativePool>;
  let hold!: () => void;
  const blocked = new Promise<void>((resolve) => {
    hold = resolve;
  });
  function rows(sql: string, values: unknown[] = []): Row[] {
    if (sql === "SELECT pg_backend_pid() AS pid")
      return [{ pid: clients.length }];
    if (sql.includes(" AS reference"))
      return [{ reference: f.b.nativeBindingReference }];
    if (sql.startsWith("BEGIN")) {
      working = structuredClone(committed);
      return [];
    }
    if (sql === "COMMIT") {
      committed = structuredClone(working);
      return [];
    }
    if (sql === "ROLLBACK") {
      working = structuredClone(committed);
      return [];
    }
    if (sql.startsWith("SET LOCAL")) return [];
    if (sql.includes("FROM native_session_candidate.bindings"))
      return [working.binding];
    if (sql.includes("FROM public.external_identities"))
      return [{ accountId: ACCOUNT }];
    const account = {
      account_id: ACCOUNT,
      actor_subject: `zp:account:${ACCOUNT}`,
      status: "ACTIVE",
      version: working.version,
      created_at: new Date(START).toISOString(),
      updated_at: new Date(START).toISOString(),
    };
    if (sql.includes("FROM public.accounts"))
      return [
        {
          accountId: ACCOUNT,
          actorSubject: account.actor_subject,
          status: "ACTIVE",
          version: working.version,
          updatedAt: String(START),
        },
      ];
    if (sql.startsWith("SELECT * FROM accounts")) return [account];
    if (sql.includes("clock_timestamp()")) return [{ observed: String(START) }];
    if (sql.startsWith("UPDATE native_session_candidate.bindings")) {
      working.binding = {
        ...working.binding,
        lastObservedAt: String(values[1]),
        state: values[2],
        attemptState: values[3],
        ownerSubject: values[4],
        accountId: values[5],
        canonicalAccountSessionId: values[6],
      };
      return [working.binding];
    }
    if (sql.includes("INSERT INTO account_sessions")) {
      working.session = {
        session_id: values[0],
        account_id: values[1],
        created_at: values[2],
        expires_at: values[3],
        revoked_at: null,
      };
      return [working.session];
    }
    if (sql.includes("UPDATE accounts SET version")) {
      working.version = String(BigInt(working.version) + 1n);
      return [{ ...account, version: working.version }];
    }
    if (sql.includes("INSERT INTO account_security_events")) {
      working.events++;
      return [
        {
          event_id: "1",
          account_id: ACCOUNT,
          sequence_number: "1",
          event_type: values[1],
          account_version: working.version,
          session_id: values[3],
          identity_id: null,
          details: "{}",
          occurred_at: values[6],
        },
      ];
    }
    if (sql.includes("FROM public.account_sessions") && working.session)
      return [
        {
          canonicalAccountSessionId: working.session.session_id,
          accountId: ACCOUNT,
          createdAt: String(Date.parse(String(working.session.created_at))),
          expiresAt: String(Date.parse(String(working.session.expires_at))),
          revokedAt: null,
        },
      ];
    throw new Error("Unexpected simulated statement");
  }
  class SimulatedConnection extends EventEmitter {
    parsedStatements = {};
    _connecting = false;
    text = "";
    values: unknown[] = [];
    ended = false;
    closing = false;
    emitLate = false;
    stream = { destroy: () => this.end() };
    connect() {
      this._connecting = true;
      setImmediate(() => this.emit("connect"));
    }
    startup() {
      setImmediate(() => this.emit("readyForQuery", { status: "I" }));
    }
    parse({ text }: { text: string }) {
      this.text = text;
    }
    bind({ values }: { values: unknown[] }) {
      this.values = values;
    }
    describe() {}
    sync() {}
    execute() {
      this.query(this.text, this.values);
    }
    end() {
      if (this.closing || this.ended) return;
      this.closing = true;
      trace.push("end-request");
      setImmediate(() => {
        if (this.emitLate) {
          trace.push("late-error");
          this.emit(
            "error",
            Object.assign(new Error(hostile), {
              code: mode === "late-unexpected" ? "XX000" : "ECONNRESET",
            }),
          );
        }
        working = structuredClone(committed);
        this.ended = true;
        trace.push("end");
        this.emit("end");
      });
    }
    query(sql: string, values: unknown[] = []) {
      trace.push(sql === "ROLLBACK" ? "rollback" : "query");
      setImmediate(() => {
        if (
          failures &&
          (mode === "pid-rejection"
            ? sql === "SELECT pg_backend_pid() AS pid"
            : sql.includes("FROM native_session_candidate.bindings") &&
              sql.endsWith("FOR UPDATE"))
        ) {
          failures--;
          hold();
          // Let the test arm only this already leased PID before the disconnect.
          setImmediate(() => {
            const err = Object.assign(new Error(hostile), {
              code: mode === "unexpected" ? "XX000" : "ECONNRESET",
            });
            if (mode === "end-first") this.end();
            else if (
              [
                "event-first",
                "legacy",
                "unexpected",
                "unarmed",
                "cleanup-failure",
              ].includes(mode)
            ) {
              trace.push("error-event");
              this.emit("error", err);
            } else {
              trace.push("query-rejection");
              this.emit(
                "errorMessage",
                Object.assign(new Error(hostile), { code: "57P01" }),
              );
              this.emitLate = mode === "late" || mode === "late-unexpected";
              if (mode === "query-first") {
                setImmediate(() => {
                  trace.push("error-event");
                  this.emit("error", err);
                });
              } else this.emit("readyForQuery", { status: "E" });
            }
          });
          return;
        }
        const result = rows(sql, values);
        if (result.length) {
          const keys = Object.keys(result[0]);
          this.emit("rowDescription", {
            fields: keys.map((name) => ({
              name,
              dataTypeID: 25,
              format: "text",
            })),
          });
          for (const row of result)
            this.emit("dataRow", {
              fields: keys.map((k) => (row[k] == null ? null : String(row[k]))),
            });
        }
        this.emit("commandComplete", { text: `SELECT ${result.length}` });
        this.emit("readyForQuery", { status: "I" });
      });
    }
  }
  const pool = {
    query: async (sql: string, values?: unknown[]) => ({
      rows: rows(sql, values),
    }),
    connect: async () => {
      const connection = new SimulatedConnection();
      const client = new Client({
        connection,
        ssl: false,
      } as unknown as ClientConfig) as PoolClient;
      await client.connect();
      if (mode === "ownership") client.on("error", foreign);
      client.release = (destroy?: boolean | Error) => {
        trace.push("released");
        releases.push(Boolean(destroy));
        assert.ok(!destroy || connection.ended);
        if (mode === "cleanup-failure") throw new Error(hostile);
      };
      clients.push(client);
      return client;
    },
  } as unknown as Pick<Pool, "query" | "connect">;
  instrument = instrumentNativePool(
    pool,
    async (sql) => {
      before++;
      if (
        hookFault &&
        mode === "before-hook" &&
        sql.includes("FROM native_session_candidate.bindings")
      ) {
        hookFault = false;
        hold();
        throw new Error(hostile);
      }
      if (sql === "ROLLBACK") trace.push("rollback-attempt");
    },
    async (sql) => {
      after++;
      if (
        hookFault &&
        mode === "after-hook" &&
        sql.includes("FROM native_session_candidate.bindings")
      ) {
        hookFault = false;
        hold();
        throw new Error(hostile);
      }
    },
  );
  // Prior unowned lease pattern: the fault occurs before simulated disposal.
  const legacy = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      await client.query("SELECT pg_backend_pid() AS pid");
      return {
        query: client.query.bind(client),
        release: () => {
          void client.end();
        },
      } as unknown as PoolClient;
    },
  } as Pick<Pool, "query" | "connect">;
  const core = new NativeSessionCore(
    new PostgresNativeSessionPersistence(
      mode === "legacy" ? legacy : instrument.source,
    ),
    f.policy,
    86_400_000,
  );
  const complete = () =>
    core.complete({
      loginAttemptId: f.b.loginAttemptId,
      evidence: f.evidence,
      accessSecret: ACCESS,
    });
  const pending = complete();
  if (!healthy) {
    await blocked;
    if (
      ![
        "legacy",
        "unarmed",
        "pid-rejection",
        "before-hook",
        "after-hook",
      ].includes(mode)
    )
      instrument.expectTermination(instrument.pids[0]);
  }
  const result = await pending;
  if (healthy) {
    assert.equal(result.kind, "account-access");
    await instrument.settle();
    assert.equal(releases[0], false);
    assert.ok(before > 0 && before === after);
    if (mode === "ownership") {
      assert.deepEqual(clients[0].listeners("error"), [foreign]);
      const leased = await instrument.source.connect();
      leased.release();
      const count = trace.length;
      await assert.rejects(leased.query("SELECT 1"));
      assert.equal(trace.length, count);
      assert.throws(() => leased.release());
      await instrument.settle();
      assert.deepEqual(clients[1].listeners("error"), [foreign]);
    }
  } else {
    assert.deepEqual(result, {
      kind: "unavailable",
      code: "AUTHORITY_UNAVAILABLE",
    });
    assert.equal(committed.binding.state, "PENDING");
    assert.equal(committed.session, null);
    assert.equal(committed.version, "0");
    assert.equal(committed.events, 0);
    if (mode === "legacy") return;
    await instrument.settle(); // Unexpected errors must fail this subprocess here.
    assert.deepEqual(releases, [true]);
    if (mode !== "pid-rejection") assert.ok(trace.includes("rollback-attempt"));
    assert.equal(clients[0].listenerCount("error"), 0);
    if (mode === "query-first" || mode === "late")
      assert.ok(
        trace.indexOf("query-rejection") <
          trace.indexOf(mode === "late" ? "late-error" : "error-event"),
      );
    assert.ok(trace.indexOf("end") < trace.indexOf("released"));
    const recovered = await complete();
    assert.equal(recovered.kind, "account-access");
    await instrument.settle();
    assert.equal(clients.length, 2);
    assert.equal(committed.binding.state, "ACTIVE");
    assert.equal(committed.events, 1);
  }
  for (const client of clients) await client.end();
  await tick();
}
for (let i = 0; i < names.length; i++)
  test(names[i], i === 10 ? scenario : () => {});
