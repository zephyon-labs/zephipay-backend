import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Account,
  Binding,
  CanonicalSession,
  SessionPersistence,
  SessionTransaction,
} from "../src/nativeSession/contracts";
import { NativeSessionCore } from "../src/nativeSession/core";
import { sessionId } from "../src/nativeSession/values";
import {
  ACCESS,
  ACCOUNT,
  CLIENT,
  fixture,
  OTHER_ACCOUNT,
  REVOCATION,
  START,
} from "./helpers/nativeSessionHarness";
import { NativeCredentialPolicy } from "../src/nativeSession/policy";

/** Intentionally adversarial port: no cloning or state guards to sanitize the core's inputs. */
function rawPort(f: ReturnType<typeof fixture>) {
  const account = { ...f.memory.snapshot().accounts.get(ACCOUNT)! };
  let binding: Binding = f.b;
  let session: CanonicalSession = {
    canonicalAccountSessionId: sessionId("00000000-0000-4000-8000-000000000501"),
    accountId: ACCOUNT,
    createdAt: START,
    expiresAt: START + 86_400_000,
    revokedAt: null,
  };
  const writes: string[] = [];
  const tx: SessionTransaction = {
    binding: async () => binding,
    resolveExisting: async () => ACCOUNT,
    lockAccount: async () => account,
    lockSession: async () => session,
    observeTime: async () => f.memory.now,
    saveBinding: async (b) => {
      writes.push("save");
      binding = b;
    },
    createSession: async (a, createdAt, expiresAt) => {
      writes.push("create");
      session = { ...session, accountId: a.accountId, createdAt, expiresAt };
      return session;
    },
    revokeSession: async () => {
      writes.push("revoke");
    },
  };
  const persistence: SessionPersistence = {
    bindingForAttempt: async () => f.b.nativeBindingReference,
    transaction: async (_reference, body) => body(tx),
  };
  const core = new NativeSessionCore(persistence, f.policy, 86_400_000);
  const complete = () =>
    core.complete({
      loginAttemptId: f.b.loginAttemptId,
      accessSecret: ACCESS,
      evidence: f.evidence,
    });
  const validate = () =>
    core.validate({
      nativeBindingReference: f.b.nativeBindingReference,
      accessSecret: ACCESS,
      evidence: f.evidence,
    });
  return { tx, account, core, complete, validate, writes };
}

test("P2-01 original: expired-token denial cannot be undone by one millisecond of rollback", async () => {
  const f = fixture();
  assert.equal((await f.complete()).kind, "account-access");
  f.memory.now = START + 300_000;
  assert.deepEqual(await f.validate(), { kind: "rejected", code: "ACCESS_TOKEN_EXPIRED" });
  const watermark = f.memory.snapshot().bindings.get(f.b.nativeBindingReference)!.lastObservedAt;
  f.memory.now--;
  const result = await f.validate();
  assert.notEqual(
    result.kind,
    "account-access",
    `rollback resurrected authority: ${JSON.stringify(result)}`,
  );
  assert.equal(watermark, START + 300_000);
  assert.equal(result.kind, "unavailable");
});

test("P2-02 original A: resolved Account A must equal the account returned by lockAccount", async () => {
  const f = fixture(),
    p = rawPort(f);
  p.tx.lockAccount = async () => ({
    ...p.account,
    accountId: OTHER_ACCOUNT,
    actorSubject: `zp:account:${OTHER_ACCOUNT}`,
  });
  const result = await p.complete();
  assert.equal(
    result.kind,
    "unavailable",
    `Alice received Bob's account: ${JSON.stringify(result)}`,
  );
  assert.deepEqual(p.writes, []);
});

test("P2-02 original B: changing persistence properties cannot split account validation and projection", async () => {
  const f = fixture(),
    p = rawPort(f);
  let changed = false;
  p.tx.lockAccount = async () =>
    new Proxy(p.account, {
      get(target, key, receiver) {
        return key === "accountId" && changed ? OTHER_ACCOUNT : Reflect.get(target, key, receiver);
      },
    });
  const save = p.tx.saveBinding;
  p.tx.saveBinding = async (b) => {
    await save(b);
    if (b.state === "ACTIVE") changed = true;
  };
  const result = await p.complete();
  assert.equal(
    result.kind,
    "unavailable",
    `inconsistent account projection: ${JSON.stringify(result)}`,
  );
  assert.deepEqual(p.writes, []);
});

test("P2-02 original C: unsupported binding state with plausible canonical linkage denies access", async () => {
  const f = fixture(),
    p = rawPort(f);
  assert.equal((await p.complete()).kind, "account-access");
  const current = (await p.tx.binding())!;
  p.tx.binding = async () => ({ ...current, state: "UNSUPPORTED" as Binding["state"] });
  p.writes.length = 0;
  const result = await p.validate();
  assert.equal(
    result.kind,
    "unavailable",
    `unsupported state granted access: ${JSON.stringify(result)}`,
  );
  assert.deepEqual(p.writes, []);
});

for (const reason of [
  "scope",
  "bootstrap",
  "unknown-account",
  "suspended",
  "future-issue",
  "pending-validation",
] as const)
  test(`committed ${reason} denial retains only the server observation`, async () => {
    const f = fixture();
    f.memory.now += 100;
    const claims: Record<string, unknown> = f.claims();
    if (reason === "scope") claims.scopes = ["read:account"];
    if (reason === "bootstrap") delete claims.bootstrap;
    if (reason === "unknown-account") claims.subject = "unknown";
    if (reason === "suspended") f.memory.setAccountStatus("SUSPENDED");
    if (reason === "future-issue") claims.issuedAt = f.memory.now + 100_000;
    const evidence = f.auth.issue(claims);
    const run = () =>
      reason === "pending-validation" ? f.validate(evidence) : f.complete(evidence);
    assert.equal((await run()).kind, "rejected");
    assert.equal(
      f.memory.snapshot().bindings.get(f.b.nativeBindingReference)!.lastObservedAt,
      START + 100,
    );
    assert.equal(f.memory.snapshot().events.length, 0);
    f.memory.now--;
    assert.equal((await run()).kind, "unavailable");
  });

for (const fault of ["after-save", "before-commit", "after-commit"] as const)
  test(`${fault}: expired-token denial is acknowledged only after a known commit`, async () => {
    const f = fixture();
    await f.complete();
    f.memory.now += 300_000;
    f.memory.fault = fault;
    assert.equal((await f.validate()).kind, "unavailable");
    const b = f.memory.snapshot().bindings.get(f.b.nativeBindingReference)!;
    assert.equal(b.lastObservedAt, fault === "after-commit" ? START + 300_000 : START);
    assert.equal(b.state, "ACTIVE");
    assert.equal(f.memory.snapshot().events.length, 1);
    assert.deepEqual(await f.validate(), { kind: "rejected", code: "ACCESS_TOKEN_EXPIRED" });
    f.memory.now--;
    assert.equal((await f.validate()).kind, "unavailable");
  });

test("watermark and terminal expiry roll back together when the terminal write fails", async () => {
  const f = fixture();
  f.memory.now = f.b.attemptExpiresAt;
  let saves = 0;
  const persistence: SessionPersistence = {
    bindingForAttempt: (id) => f.memory.bindingForAttempt(id),
    transaction: (reference, body) =>
      f.memory.transaction(reference, (tx) =>
        body({
          ...tx,
          saveBinding: async (b) => {
            await tx.saveBinding(b);
            if (++saves === 2) throw new Error("terminal write failed");
          },
        }),
      ),
  };
  const core = new NativeSessionCore(persistence, f.policy, 86_400_000);
  const result = await core.complete({
    loginAttemptId: f.b.loginAttemptId,
    accessSecret: ACCESS,
    evidence: f.auth.issue(f.claims()),
  });
  assert.equal(result.kind, "unavailable");
  assert.equal(saves, 2);
  assert.equal(f.memory.snapshot().bindings.get(f.b.nativeBindingReference)!.lastObservedAt, START);
  assert.equal(f.memory.snapshot().bindings.get(f.b.nativeBindingReference)!.state, "PENDING");
  assert.equal((await f.complete(f.auth.issue(f.claims()))).kind, "terminal");
});

test("untrusted evidence, proofs, identities and credential classes cannot sample or advance the watermark", async () => {
  const f = fixture();
  await f.complete();
  f.memory.now += 100;
  f.memory.clock = () => {
    throw new Error("untrusted request reached clock");
  };
  const before = f.memory.snapshot();
  const results = [
    await f.validate({}),
    await f.validate(f.auth.issue(f.claims({ issuer: "https://other.invalid/" }))),
    await f.validate(f.auth.issue(f.claims({ azp: "unknown" }))),
    await f.validate(f.auth.issue(f.claims({ subject: "bob" }))),
    await f.core.validate({
      nativeBindingReference: f.b.nativeBindingReference,
      accessSecret: REVOCATION,
      evidence: f.evidence,
    }),
    await f.core.validate({
      nativeBindingReference: f.b.nativeBindingReference,
      accessSecret: ACCESS,
      evidence: f.evidence,
      observedAt: START + 999_999,
    }),
  ];
  const policy = new NativeCredentialPolicy(f.auth, [{ ...CLIENT, credentialClass: "legacy-web" }]);
  const core = new NativeSessionCore(f.memory, policy, 86_400_000);
  const claims: Record<string, unknown> = f.claims();
  delete claims.bootstrap;
  results.push(
    await core.validate({
      nativeBindingReference: f.b.nativeBindingReference,
      accessSecret: ACCESS,
      evidence: f.auth.issue(claims),
    }),
  );
  for (const result of results)
    assert.ok(result.kind === "rejected" || result.kind === "conflict", JSON.stringify(result));
  assert.deepEqual(f.memory.snapshot(), before);
  assert.ok(f.memory.traces.slice(1).every((t) => !t.includes("clock")));
});

for (const [name, clock] of [
  ["rollback", () => START - 1],
  ["NaN", () => NaN],
  ["infinity", () => Infinity],
  ["fractional", () => START + 0.5],
  [
    "exception",
    () => {
      throw new Error("clock error");
    },
  ],
] as const)
  test(`clock ${name} cannot persist a denial watermark`, async () => {
    const f = fixture();
    await f.complete();
    const before = f.memory.snapshot();
    f.memory.clock = clock;
    assert.equal((await f.validate()).kind, "unavailable");
    assert.deepEqual(f.memory.snapshot(), before);
  });

const accountAttacks: [string, (a: Account) => unknown][] = [
  ["inconsistent actor", (a) => ({ ...a, actorSubject: `zp:account:${OTHER_ACCOUNT}` })],
  ["unknown status", (a) => ({ ...a, status: "UNSUPPORTED" })],
  ["numeric version", (a) => ({ ...a, version: 0 })],
  ["negative version", (a) => ({ ...a, version: -1n })],
  ["invalid time", (a) => ({ ...a, updatedAt: NaN })],
  [
    "missing field",
    (a) => {
      const { version: _version, ...rest } = a;
      return rest;
    },
  ],
  ["extra authority field", (a) => ({ ...a, economicAuthority: true })],
  ["non-data prototype", (a) => Object.assign(Object.create({ inherited: true }), a)],
];
for (const [name, corrupt] of accountAttacks)
  test(`malformed account ${name} is unavailable before any write`, async () => {
    const f = fixture(),
      p = rawPort(f);
    p.tx.lockAccount = async () => corrupt(p.account) as Account;
    assert.equal((await p.complete()).kind, "unavailable");
    assert.deepEqual(p.writes, []);
  });

for (const field of ["accountId", "actorSubject", "status", "version", "updatedAt"] as const)
  test(`account ${field} accessors are rejected without executing them`, async () => {
    const f = fixture(),
      p = rawPort(f);
    let calls = 0;
    const value = { ...p.account };
    Object.defineProperty(value, field, {
      get: () => {
        calls++;
        throw new Error("getter invoked");
      },
    });
    p.tx.lockAccount = async () => value;
    assert.equal((await p.complete()).kind, "unavailable");
    assert.equal(calls, 0);
    assert.deepEqual(p.writes, []);
  });

for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const)
  test(`persistence ${trap} traps cannot execute during reflection`, async () => {
    const f = fixture(),
      p = rawPort(f);
    let calls = 0;
    p.tx.lockAccount = async () =>
      new Proxy(p.account, {
        [trap]: () => {
          calls++;
          throw new Error("reflection trap");
        },
      });
    assert.equal((await p.complete()).kind, "unavailable");
    assert.equal(calls, 0);
    assert.deepEqual(p.writes, []);
  });

test("revoked proxy and malformed descriptor proxies fail closed", async () => {
  for (const make of [
    (a: Account) => {
      const p = Proxy.revocable(a, {});
      p.revoke();
      return p.proxy;
    },
    (a: Account) =>
      new Proxy(a, {
        getOwnPropertyDescriptor: () => ({ value: ACCOUNT, get: () => OTHER_ACCOUNT }),
      }),
  ]) {
    const f = fixture(),
      p = rawPort(f);
    p.tx.lockAccount = async () => make(p.account);
    assert.equal((await p.complete()).kind, "unavailable");
    assert.deepEqual(p.writes, []);
  }
});

const bindingAttacks: [string, (b: Binding) => unknown][] = [
  ["unknown attempt", (b) => ({ ...b, attemptState: "UNSUPPORTED" })],
  ["active pending attempt", (b) => ({ ...b, attemptState: "PENDING" })],
  ["pending completed attempt", (b) => ({ ...b, state: "PENDING" })],
  ["cancelled completed attempt", (b) => ({ ...b, state: "CANCELLED" })],
  [
    "missing owner",
    (b) => {
      const { owner: _owner, ...rest } = b;
      return rest;
    },
  ],
  [
    "missing session",
    (b) => {
      const { canonicalAccountSessionId: _id, ...rest } = b;
      return rest;
    },
  ],
  [
    "owner issuer mismatch",
    (b) => ({ ...b, owner: { ...b.owner, issuer: "https://other.invalid/" } }),
  ],
  [
    "canonical ID mismatch",
    (b) => ({ ...b, canonicalAccountSessionId: sessionId("00000000-0000-4000-8000-000000000502") }),
  ],
  ["unobserved expiry", (b) => ({ ...b, state: "EXPIRED" })],
  ["uncommitted revocation", (b) => ({ ...b, state: "REVOKED" })],
  ["invalid deadline", (b) => ({ ...b, attemptExpiresAt: b.createdAt })],
  ["invalid watermark", (b) => ({ ...b, lastObservedAt: NaN })],
  ["early watermark", (b) => ({ ...b, lastObservedAt: b.createdAt - 1 })],
  ["extra field", (b) => ({ ...b, economicAuthority: true })],
];
for (const [name, corrupt] of bindingAttacks)
  test(`contradictory binding ${name} is unavailable before access`, async () => {
    const f = fixture(),
      p = rawPort(f);
    assert.equal((await p.complete()).kind, "account-access");
    const b = (await p.tx.binding())!;
    p.tx.binding = async () => corrupt(b) as Binding;
    p.writes.length = 0;
    assert.equal((await p.validate()).kind, "unavailable");
    assert.deepEqual(p.writes, []);
  });

test("binding and nested owner/context accessors are rejected without executing them", async () => {
  for (const target of ["binding", "owner", "context"] as const) {
    const f = fixture(),
      p = rawPort(f);
    await p.complete();
    const b = structuredClone((await p.tx.binding())!);
    let calls = 0;
    const record = target === "binding" ? b : b[target]!;
    Object.defineProperty(record, target === "binding" ? "state" : "issuer", {
      get: () => {
        calls++;
        return "substitution";
      },
    });
    p.tx.binding = async () => b;
    p.writes.length = 0;
    assert.equal((await p.validate()).kind, "unavailable");
    assert.equal(calls, 0);
    assert.deepEqual(p.writes, []);
  }
});

const sessionAttacks: [string, (s: CanonicalSession) => unknown][] = [
  ["wrong account", (s) => ({ ...s, accountId: OTHER_ACCOUNT })],
  ["invalid ID", (s) => ({ ...s, canonicalAccountSessionId: "invalid" })],
  ["invalid expiry", (s) => ({ ...s, expiresAt: NaN })],
  ["reversed lifetime", (s) => ({ ...s, expiresAt: s.createdAt })],
  ["missing revocation state", (s) => ({ ...s, revokedAt: undefined })],
  ["revocation before creation", (s) => ({ ...s, revokedAt: s.createdAt - 1 })],
  ["extra session state", (s) => ({ ...s, state: "UNSUPPORTED" })],
  [
    "accessor",
    (s) =>
      Object.defineProperty({ ...s }, "expiresAt", {
        get: () => {
          throw new Error("getter");
        },
      }),
  ],
  ["proxy", (s) => new Proxy(s, { get: () => "substitution" })],
];
for (const [name, corrupt] of sessionAttacks)
  test(`canonical session ${name} cannot grant existing access`, async () => {
    const f = fixture(),
      p = rawPort(f);
    await p.complete();
    const s = await p.tx.lockSession(sessionId("00000000-0000-4000-8000-000000000501"));
    p.tx.lockSession = async () => corrupt(s) as CanonicalSession;
    p.writes.length = 0;
    assert.equal((await p.validate()).kind, "unavailable");
    assert.deepEqual(p.writes, []);
  });

test("malformed canonical creation rolls back the watermark, session and security event", async () => {
  const f = fixture();
  f.memory.now += 100;
  const persistence: SessionPersistence = {
    bindingForAttempt: (id) => f.memory.bindingForAttempt(id),
    transaction: (reference, body) =>
      f.memory.transaction(reference, (tx) =>
        body({
          ...tx,
          createSession: async (account, createdAt, expiresAt) =>
            new Proxy(await tx.createSession(account, createdAt, expiresAt), {}),
        }),
      ),
  };
  const core = new NativeSessionCore(persistence, f.policy, 86_400_000);
  assert.equal(
    (
      await core.complete({
        loginAttemptId: f.b.loginAttemptId,
        accessSecret: ACCESS,
        evidence: f.evidence,
      })
    ).kind,
    "unavailable",
  );
  const s = f.memory.snapshot();
  assert.equal(s.sessions.size, 0);
  assert.equal(s.events.length, 0);
  assert.equal(s.bindings.get(f.b.nativeBindingReference)!.lastObservedAt, START);
});

test("owned snapshots remain consistent when later callbacks mutate returned record objects", async () => {
  const f = fixture(),
    p = rawPort(f);
  const binding = structuredClone(f.b);
  p.tx.binding = async () => binding;
  p.tx.observeTime = async () => {
    p.account.accountId = OTHER_ACCOUNT;
    p.account.actorSubject = `zp:account:${OTHER_ACCOUNT}`;
    (binding.context as { issuer: string }).issuer = "https://substitution.invalid/";
    (binding as { state: string }).state = "UNSUPPORTED";
    return START;
  };
  const result = await p.complete();
  assert.equal(result.kind, "account-access");
  if (result.kind !== "account-access") throw new Error("fixture");
  assert.deepEqual(result.account, { accountId: ACCOUNT, actorSubject: `zp:account:${ACCOUNT}` });
  assert.equal(result.identity.issuer, CLIENT.issuer);
});

test("a queued revocation invalidates subsequent access without reopening state after clock callbacks", async () => {
  const f = fixture();
  await f.complete();
  f.memory.now += 100;
  let revoke: ReturnType<typeof f.revoke> | undefined;
  f.memory.beforeClock = async () => {
    revoke = f.revoke();
  };
  assert.equal((await f.validate()).kind, "account-access");
  assert.equal((await revoke!).kind, "terminal");
  assert.equal((await f.complete()).kind, "terminal");
  assert.equal((await f.validate()).kind, "terminal");
  assert.equal(f.memory.snapshot().events.length, 2);
});

test("memory store independently rejects unknown and contradictory state writes", async () => {
  const f = fixture();
  for (const changes of [
    { state: "UNSUPPORTED" },
    { state: "ACTIVE" },
    { attemptState: "COMPLETED" },
    { state: "EXPIRED", attemptState: "EXPIRED" },
  ]) {
    await assert.rejects(() =>
      f.memory.transaction(f.b.nativeBindingReference, async (tx) =>
        tx.saveBinding({ ...(await tx.binding())!, ...changes } as Binding),
      ),
    );
  }
  assert.equal(f.memory.snapshot().bindings.get(f.b.nativeBindingReference)!.state, "PENDING");
  assert.equal((await f.complete()).kind, "account-access");
  assert.equal((await f.validate()).kind, "account-access");
  assert.equal((await f.revoke()).kind, "terminal");
  assert.equal((await f.revoke()).kind, "terminal");
  assert.equal(f.memory.snapshot().events.length, 2);
});

test("existing-session account mismatch stops before the canonical session lock", async () => {
  const f = fixture(),
    p = rawPort(f);
  await p.complete();
  p.writes.length = 0;
  let sessionLocks = 0;
  p.tx.lockAccount = async () => ({
    ...p.account,
    accountId: OTHER_ACCOUNT,
    actorSubject: `zp:account:${OTHER_ACCOUNT}`,
  });
  p.tx.lockSession = async () => {
    sessionLocks++;
    throw new Error("wrong account session lock");
  };
  assert.equal((await p.validate()).kind, "unavailable");
  assert.equal(sessionLocks, 0);
  assert.deepEqual(p.writes, []);
});

test("unsupported binding state cannot be completed or acknowledged as revoked", async () => {
  for (const operation of ["complete", "revoke"] as const) {
    const f = fixture(),
      p = rawPort(f);
    p.tx.binding = async () => ({ ...f.b, state: "UNSUPPORTED" as Binding["state"] });
    const result =
      operation === "complete"
        ? await p.complete()
        : await p.core.revoke({
            nativeBindingReference: f.b.nativeBindingReference,
            revocationSecret: REVOCATION,
          });
    assert.equal(result.kind, "unavailable");
    assert.deepEqual(p.writes, []);
  }
});

test("plain null-prototype persistence records remain supported", async () => {
  const f = fixture(),
    p = rawPort(f);
  p.tx.lockAccount = async () => Object.assign(Object.create(null), p.account);
  const result = await p.complete();
  assert.equal(result.kind, "account-access");
  if (result.kind !== "account-access") throw new Error("fixture");
  assert.equal(result.account.accountId, ACCOUNT);
  assert.equal((await p.validate()).kind, "account-access");
});
