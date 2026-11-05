import assert from "node:assert/strict";
import { test } from "node:test";
import type { Binding, Result } from "../src/nativeSession/contracts";
import { bindingReference } from "../src/nativeSession/values";
import { InMemoryIdentityPersistence } from "../src/storage/memory/inMemoryIdentityPersistence";
import {
  ACCESS,
  ACCOUNT,
  fixture,
  OTHER_ACCOUNT,
  REVOCATION,
  START,
} from "./helpers/nativeSessionHarness";

function kind(result: Result, expected: Result["kind"]): void {
  assert.equal(result.kind, expected, JSON.stringify(result));
}
function bound(f: ReturnType<typeof fixture>): Binding {
  return f.memory.snapshot().bindings.get(f.b.nativeBindingReference)!;
}
function refresh(f: ReturnType<typeof fixture>): object {
  const c = f.claims({ grant: "refresh_token" });
  delete (c as Record<string, unknown>).bootstrap;
  return f.auth.issue(c);
}

test("concurrent completion creates one canonical session, one event and one version increment", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.complete()));
  results.forEach((r) => kind(r, "account-access"));
  assert.equal(
    new Set(results.map((r) => r.kind === "account-access" && r.canonicalAccountSessionId)).size,
    1,
  );
  const s = f.memory.snapshot();
  assert.equal(s.sessions.size, 1);
  assert.equal(s.events.length, 1);
  assert.equal(s.accounts.get(ACCOUNT)!.version, 1n);
  assert.equal(bound(f).attemptState, "COMPLETED");
  assert.ok(f.memory.traces.every((t) => t.at(-1) === "commit"));
});

test("concurrent duplicate revocation is committed without repeating canonical operations", async () => {
  const f = fixture();
  await f.complete();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.revoke()));
  results.forEach((r) =>
    assert.deepEqual(r, {
      kind: "terminal",
      state: "REVOKED",
      nativeBindingReference: f.b.nativeBindingReference,
    }),
  );
  const s = f.memory.snapshot();
  assert.equal(s.events.length, 2);
  assert.equal(s.accounts.get(ACCOUNT)!.version, 2n);
  assert.equal(s.events.filter((e) => e.type === "SESSION_REVOKED").length, 1);
  kind(await f.validate(), "terminal");
  kind(await f.complete(), "terminal");
});

for (const winner of ["cancel", "complete"] as const)
  test(`controlled race: ${winner} obtains binding serialization first`, async () => {
    const f = fixture();
    if (winner === "cancel") {
      const first = f.revoke();
      const second = f.complete();
      const results = await Promise.all([first, second]);
      results.forEach((r) => assert.equal(r.kind === "terminal" && r.state, "CANCELLED"));
      assert.equal(f.memory.snapshot().sessions.size, 0);
    } else {
      let acquired!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => {
        acquired = r;
      });
      const hold = new Promise<void>((r) => {
        release = r;
      });
      f.memory.beforeClock = async () => {
        acquired();
        await hold;
      };
      const first = f.complete();
      await ready;
      const second = f.revoke();
      release();
      kind(await first, "account-access");
      assert.equal((await second).kind, "terminal");
      assert.equal(bound(f).state, "REVOKED");
      assert.equal(f.memory.snapshot().events.length, 2);
    }
  });

test("attempt expiry equality commits terminal state, including after clock correction", async () => {
  const f = fixture();
  f.memory.now = f.b.attemptExpiresAt;
  const evidence = f.auth.issue(f.claims());
  assert.equal((await f.complete(evidence)).kind, "terminal");
  assert.equal(bound(f).state, "EXPIRED");
  assert.equal(f.memory.snapshot().sessions.size, 0);
  f.memory.now = START;
  kind(await f.complete(), "unavailable");
  assert.equal(bound(f).state, "EXPIRED");
  f.memory.now = f.b.attemptExpiresAt + 1;
  assert.equal((await f.complete(f.auth.issue(f.claims()))).kind, "terminal");
});

test("session expiry equality commits terminal state and cannot be renewed by refresh", async () => {
  const f = fixture();
  const initial = await f.complete();
  assert.equal(initial.kind, "account-access");
  if (initial.kind !== "account-access") throw new Error("fixture");
  f.memory.now = initial.expiresAt;
  assert.equal((await f.validate(refresh(f))).kind, "terminal");
  assert.equal(bound(f).state, "EXPIRED");
  assert.equal(f.memory.snapshot().accounts.get(ACCOUNT)!.version, 1n);
  f.memory.now++;
  kind(await f.complete(f.auth.issue(f.claims())), "terminal");
  assert.equal(f.memory.snapshot().sessions.size, 1);
});

test("access-token expiry equality rejects without reporting session revocation", async () => {
  const f = fixture();
  await f.complete();
  f.memory.now += 300_000;
  assert.deepEqual(await f.validate(), { kind: "rejected", code: "ACCESS_TOKEN_EXPIRED" });
  assert.equal(bound(f).state, "ACTIVE");
  kind(await f.validate(refresh(f)), "account-access");
});

for (const fault of ["after-create", "after-save", "before-commit"] as const)
  test(`${fault}: rollback cannot manufacture successful completion`, async () => {
    const f = fixture();
    f.memory.fault = fault;
    kind(await f.complete(), "unavailable");
    assert.equal(f.memory.snapshot().sessions.size, 0);
    assert.equal(f.memory.snapshot().events.length, 0);
    assert.equal(bound(f).state, "PENDING");
    kind(await f.complete(), "account-access");
    assert.equal(f.memory.snapshot().sessions.size, 1);
  });

test("lost completion acknowledgement is unavailable; new core instance recovers existing state", async () => {
  const f = fixture();
  f.memory.fault = "after-commit";
  kind(await f.complete(), "unavailable");
  assert.equal(bound(f).state, "ACTIVE");
  assert.equal(f.memory.snapshot().sessions.size, 1);
  const { NativeSessionCore } = await import("../src/nativeSession/core");
  const recovered = new NativeSessionCore(f.memory, f.policy, 86_400_000);
  const result = await recovered.validate({
    nativeBindingReference: f.b.nativeBindingReference,
    evidence: refresh(f),
    accessSecret: ACCESS,
  });
  kind(result, "account-access");
  kind(await f.complete(), "account-access");
  assert.equal(f.memory.snapshot().events.length, 1);
});

for (const fault of ["after-revoke", "after-save", "before-commit", "after-commit"] as const)
  test(`${fault}: revocation failure reports no fabricated acknowledgement`, async () => {
    const f = fixture();
    await f.complete();
    f.memory.fault = fault;
    kind(await f.revoke(), "unavailable");
    assert.equal(bound(f).state, fault === "after-commit" ? "REVOKED" : "ACTIVE");
    assert.equal(
      f.memory.snapshot().accounts.get(ACCOUNT)!.version,
      fault === "after-commit" ? 2n : 1n,
    );
    kind(await f.revoke(), "terminal");
    assert.equal(f.memory.snapshot().events.length, 2);
  });

for (const fault of ["before-commit", "after-commit"] as const)
  test(`${fault}: terminal expiry cannot depend on a rolled-back transaction`, async () => {
    const f = fixture();
    f.memory.now += 300_000;
    f.memory.fault = fault;
    kind(await f.complete(f.auth.issue(f.claims())), "unavailable");
    assert.equal(bound(f).state, fault === "after-commit" ? "EXPIRED" : "PENDING");
    kind(await f.complete(f.auth.issue(f.claims())), "terminal");
    assert.equal(bound(f).state, "EXPIRED");
  });

test("old successful completion never returns cached account access after revocation", async () => {
  const f = fixture();
  const original = await f.complete();
  kind(original, "account-access");
  await f.revoke();
  kind(await f.complete(), "terminal");
  assert.equal(f.memory.snapshot().sessions.size, 1);
});

test("bootstrap replay cannot bind another attempt; refreshed tokens cannot bootstrap", async () => {
  const f = fixture();
  await f.complete();
  const other = f.memory.seedBinding(2);
  assert.deepEqual(
    await f.core.complete({
      loginAttemptId: other.loginAttemptId,
      accessSecret: ACCESS,
      evidence: f.evidence,
    }),
    { kind: "rejected", code: "BOOTSTRAP_REQUIRED" },
  );
  assert.deepEqual(
    await f.core.complete({
      loginAttemptId: other.loginAttemptId,
      accessSecret: ACCESS,
      evidence: refresh(f),
    }),
    { kind: "rejected", code: "BOOTSTRAP_REQUIRED" },
  );
  assert.equal(f.memory.snapshot().sessions.size, 1);
});

test("fresh explicit bootstrap can create a different binding without reviving a revoked one", async () => {
  const f = fixture();
  await f.complete();
  await f.revoke();
  const other = f.memory.seedBinding(2);
  const evidence = f.auth.issue(
    f.claims({
      bootstrap: { version: 1, loginAttemptId: other.loginAttemptId, challenge: other.challenge },
    }),
  );
  kind(
    await f.core.complete({ loginAttemptId: other.loginAttemptId, accessSecret: ACCESS, evidence }),
    "account-access",
  );
  assert.equal(bound(f).state, "REVOKED");
  assert.equal(f.memory.snapshot().sessions.size, 2);
});

test("existing-account-only resolution does not provision unknown identity", async () => {
  const f = fixture();
  const evidence = f.auth.issue(f.claims({ subject: "unknown" }));
  assert.deepEqual(await f.complete(evidence), {
    kind: "rejected",
    code: "ACCOUNT_NOT_PROVISIONED",
  });
  const s = f.memory.snapshot();
  assert.equal(s.accounts.size, 1);
  assert.equal(s.sessions.size, 0);
  assert.equal(s.events.length, 0);
});

test("validation of a pending or unknown binding cannot create a session", async () => {
  const f = fixture();
  assert.deepEqual(await f.validate(), { kind: "rejected", code: "SESSION_NOT_BOUND" });
  const missing = bindingReference(`binding_${"ff".repeat(16)}`);
  assert.deepEqual(
    await f.core.validate({
      nativeBindingReference: missing,
      evidence: f.evidence,
      accessSecret: ACCESS,
    }),
    { kind: "rejected", code: "SESSION_NOT_BOUND" },
  );
  assert.equal(f.memory.snapshot().sessions.size, 0);
});

test("subject switch cannot substitute another canonical account", async () => {
  const f = fixture();
  f.memory.seedAccount(OTHER_ACCOUNT, "bob");
  await f.complete();
  const bob = f.auth.issue(f.claims({ subject: "bob" }));
  kind(await f.validate(bob), "conflict");
  kind(await f.complete(bob), "conflict");
  assert.equal(bound(f).owner?.accountId, ACCOUNT);
  assert.equal(f.memory.snapshot().accounts.get(OTHER_ACCOUNT)!.version, 0n);
});

test("suspension removes account access but does not prevent session-scoped revocation", async () => {
  const f = fixture();
  await f.complete();
  f.memory.setAccountStatus("SUSPENDED");
  assert.deepEqual(await f.validate(), { kind: "rejected", code: "ACCESS_DENIED" });
  kind(await f.revoke(), "terminal");
});

test("access and revocation capabilities cannot substitute for each other or use their stored hashes", async () => {
  const f = fixture();
  for (const accessSecret of [REVOCATION, f.b.accessCommitment])
    assert.deepEqual(
      await f.core.complete({
        loginAttemptId: f.b.loginAttemptId,
        evidence: f.evidence,
        accessSecret,
      }),
      { kind: "rejected", code: "INVALID_PROOF" },
    );
  for (const revocationSecret of [ACCESS, f.b.revocationCommitment])
    assert.deepEqual(
      await f.core.revoke({ nativeBindingReference: f.b.nativeBindingReference, revocationSecret }),
      { kind: "rejected", code: "INVALID_PROOF" },
    );
  assert.equal(bound(f).state, "PENDING");
});

for (const clock of [
  () => START - 1,
  () => NaN,
  () => Infinity,
  () => -1,
  () => {
    throw new Error("clock failure");
  },
])
  test(`untrusted clock ${String(clock)} denies without mutations`, async () => {
    const f = fixture();
    f.memory.clock = clock;
    kind(await f.complete(), "unavailable");
    assert.equal(f.memory.snapshot().events.length, 0);
  });

test("clock sampled after locks rejects token that expires while waiting", async () => {
  const f = fixture();
  f.memory.beforeClock = async () => {
    f.memory.now += 300_000;
  };
  assert.deepEqual(await f.complete(), { kind: "rejected", code: "ACCESS_TOKEN_EXPIRED" });
  assert.equal(f.memory.snapshot().sessions.size, 0);
  const t = f.memory.traces[0];
  assert.ok(t.indexOf("clock") > t.findIndex((v) => v.startsWith("account:")));
});

test("persisted clock watermark rejects rollback after a successful observation", async () => {
  const f = fixture();
  await f.complete();
  f.memory.now += 100;
  kind(await f.validate(), "account-access");
  f.memory.now--;
  kind(await f.validate(), "unavailable");
  assert.equal(bound(f).lastObservedAt, START + 100);
});

test("lock traces are binding -> exclusive account -> exclusive session, with no upgrades", async () => {
  const f = fixture();
  await f.complete();
  await f.validate();
  await f.revoke();
  for (const trace of f.memory.traces) {
    assert.ok(trace[0].startsWith("binding:"));
    const account = trace.findIndex((s) => s.startsWith("account:")),
      session = trace.findIndex((s) => s.startsWith("session:"));
    assert.ok(account > 0 && session > account);
    assert.ok(
      trace
        .filter((s) => /^(binding|account|session):/.test(s))
        .every((s) => s.endsWith(":exclusive")),
    );
  }
  const id = bound(f).canonicalAccountSessionId!;
  await assert.rejects(
    () => f.memory.transaction(f.b.nativeBindingReference, (tx) => tx.lockSession(id)),
    /locked first/,
  );
  await assert.rejects(
    () =>
      f.memory.transaction(f.b.nativeBindingReference, async (tx) => {
        await tx.lockAccount(ACCOUNT);
        await tx.lockSession(id);
        await tx.lockAccount(ACCOUNT);
      }),
    /order/,
  );
});

test("synthetic canonical effects match the existing identity repository and invalidate captured account versions", async () => {
  const f = fixture();
  const existing = new InMemoryIdentityPersistence({ clock: () => new Date(START).toISOString() });
  await existing.createAccount({ accountId: ACCOUNT });
  const webChallengeVersion = f.memory.snapshot().accounts.get(ACCOUNT)!.version;
  const result = await f.complete();
  assert.equal(result.kind, "account-access");
  if (result.kind !== "account-access") throw new Error("fixture");
  const created = await existing.createAccountSession({
    sessionId: result.canonicalAccountSessionId,
    accountId: ACCOUNT,
    expectedAccountVersion: 0n,
    createdAt: new Date(START).toISOString(),
    expiresAt: new Date(result.expiresAt).toISOString(),
  });
  assert.equal(f.memory.snapshot().accounts.get(ACCOUNT)!.version, created.account.version);
  assert.notEqual(created.account.version, webChallengeVersion);
  const nextChallengeVersion = created.account.version;
  await f.complete();
  assert.equal(f.memory.snapshot().accounts.get(ACCOUNT)!.version, nextChallengeVersion);
  await f.revoke();
  const revoked = await existing.revokeAccountSession({
    sessionId: result.canonicalAccountSessionId,
    accountId: ACCOUNT,
    expectedAccountVersion: 1n,
    revokedAt: new Date(START).toISOString(),
  });
  assert.equal(f.memory.snapshot().accounts.get(ACCOUNT)!.version, revoked.account.version);
  assert.notEqual(revoked.account.version, nextChallengeVersion);
  const events = (await existing.listAccountSecurityEvents(ACCOUNT)).filter((e) =>
    e.eventType.startsWith("SESSION_"),
  );
  assert.deepEqual(
    f.memory.snapshot().events.map((e) => [e.type, e.accountVersion]),
    events.map((e) => [e.eventType, e.accountVersion]),
  );
});

test("account result contains no consent, Runtime or execution authority and no secrets", async () => {
  const f = fixture();
  const result = await f.complete();
  assert.equal(result.kind, "account-access");
  assert.equal(f.core.productionReady, false);
  assert.equal(result.kind === "account-access" && result.economicAuthority, "unavailable");
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "kind",
      "identity",
      "account",
      "nativeBindingReference",
      "canonicalAccountSessionId",
      "expiresAt",
      "observedAt",
      "economicAuthority",
    ].sort(),
  );
  const serialized = JSON.stringify(result);
  for (const secret of [ACCESS, REVOCATION, f.b.accessCommitment, f.b.revocationCommitment])
    assert.ok(!serialized.includes(secret));
  assert.ok(Object.isFrozen(result));
});

test("identifier classes and unexpected authority fields cannot be interchanged", async () => {
  const f = fixture();
  kind(
    await f.core.complete({
      loginAttemptId: f.b.nativeBindingReference,
      accessSecret: ACCESS,
      evidence: f.evidence,
    }),
    "rejected",
  );
  kind(
    await f.core.validate({
      nativeBindingReference: f.b.loginAttemptId,
      accessSecret: ACCESS,
      evidence: f.evidence,
    }),
    "rejected",
  );
  for (const key of [
    "credentialClass",
    "accountId",
    "canonicalAccountSessionId",
    "expiresAt",
    "economicAuthority",
  ])
    assert.deepEqual(
      await f.core.complete({
        loginAttemptId: f.b.loginAttemptId,
        accessSecret: ACCESS,
        evidence: f.evidence,
        [key]: "override",
      }),
      { kind: "rejected", code: "INVALID_REQUEST" },
    );
  assert.equal(f.memory.snapshot().sessions.size, 0);
});

test("descriptor snapshots avoid getter execution and post-validation property substitution", async () => {
  const f = fixture();
  let reads = 0;
  const input = { loginAttemptId: f.b.loginAttemptId, evidence: f.evidence, accessSecret: ACCESS };
  const proxy = new Proxy(input, {
    get() {
      reads++;
      return "substituted";
    },
  });
  kind(await f.core.complete(proxy), "account-access");
  assert.equal(reads, 0);
  const accessor = {
    ...input,
    get accessSecret() {
      reads++;
      return ACCESS;
    },
  };
  assert.deepEqual(await f.core.complete(accessor), { kind: "rejected", code: "INVALID_REQUEST" });
  assert.equal(reads, 0);
});

test("verifier outage is distinct from authentication rejection", async () => {
  const f = fixture();
  f.auth.fail = true;
  kind(await f.complete(), "unavailable");
  f.auth.fail = false;
  assert.deepEqual(await f.complete({}), { kind: "rejected", code: "AUTHENTICATION_REJECTED" });
});

test("memory model rejects immutable expiry and terminal reopening directly", async () => {
  const f = fixture();
  await f.revoke();
  await assert.rejects(
    () =>
      f.memory.transaction(f.b.nativeBindingReference, async (tx) => {
        const b = (await tx.binding())!;
        await tx.saveBinding({ ...b, state: "PENDING" });
      }),
    /revived/,
  );
  await assert.rejects(
    () =>
      f.memory.transaction(f.b.nativeBindingReference, async (tx) => {
        const b = (await tx.binding())!;
        await tx.saveBinding({ ...b, attemptExpiresAt: b.attemptExpiresAt + 1 });
      }),
    /Immutable/,
  );
  assert.equal(bound(f).state, "CANCELLED");
});

for (const fault of ["binding-lock", "account-lock", "session-lock"] as const)
  test(`${fault}: acquisition failure yields unavailable authority without state changes`, async () => {
    const f = fixture();
    await f.complete();
    const before = f.memory.snapshot();
    f.memory.fault = fault;
    kind(await f.revoke(), "unavailable");
    assert.deepEqual(f.memory.snapshot(), before);
    kind(await f.revoke(), "terminal");
    assert.equal(f.memory.snapshot().accounts.get(ACCOUNT)!.version, 2n);
  });

test("canonical revocation observed outside the binding is latched without repeating its version effect", async () => {
  const f = fixture();
  await f.complete();
  await f.memory.transaction(f.b.nativeBindingReference, async (tx) => {
    const b = (await tx.binding())!;
    const a = await tx.lockAccount(ACCOUNT);
    const s = await tx.lockSession(b.canonicalAccountSessionId!);
    await tx.revokeSession(a, s, await tx.observeTime());
  });
  assert.equal(bound(f).state, "ACTIVE");
  assert.equal(f.memory.snapshot().accounts.get(ACCOUNT)!.version, 2n);
  const result = await f.validate();
  assert.equal(result.kind === "terminal" && result.state, "REVOKED");
  kind(await f.revoke(), "terminal");
  kind(await f.complete(), "terminal");
  assert.equal(f.memory.snapshot().accounts.get(ACCOUNT)!.version, 2n);
  assert.equal(f.memory.snapshot().events.length, 2);
});

for (const fault of ["before-commit", "after-commit"] as const)
  test(`${fault}: cancellation retries preserve one committed terminal outcome`, async () => {
    const f = fixture();
    f.memory.fault = fault;
    kind(await f.revoke(), "unavailable");
    assert.equal(bound(f).state, fault === "after-commit" ? "CANCELLED" : "PENDING");
    const result = await f.revoke();
    assert.equal(result.kind === "terminal" && result.state, "CANCELLED");
    assert.equal(f.memory.snapshot().sessions.size, 0);
    assert.equal(f.memory.snapshot().events.length, 0);
    kind(await f.complete(), "terminal");
  });

test("bootstrap challenge substitution and bare authentication cannot complete a binding", async () => {
  const f = fixture();
  const c = f.claims({
    bootstrap: { version: 1, loginAttemptId: f.b.loginAttemptId, challenge: "44".repeat(32) },
  });
  assert.deepEqual(await f.complete(f.auth.issue(c)), {
    kind: "rejected",
    code: "BOOTSTRAP_REQUIRED",
  });
  assert.deepEqual(
    await f.core.complete({ loginAttemptId: f.b.loginAttemptId, evidence: f.evidence }),
    { kind: "rejected", code: "INVALID_REQUEST" },
  );
  assert.equal(f.memory.snapshot().sessions.size, 0);
});

test("validation preserves immutable session expiry despite refreshed credentials", async () => {
  const f = fixture();
  const first = await f.complete();
  assert.equal(first.kind, "account-access");
  if (first.kind !== "account-access") throw new Error("fixture");
  f.memory.now += 600_000;
  const result = await f.validate(refresh(f));
  assert.equal(result.kind, "account-access");
  if (result.kind !== "account-access") throw new Error("fixture");
  assert.equal(result.expiresAt, first.expiresAt);
  assert.equal(result.canonicalAccountSessionId, first.canonicalAccountSessionId);
  assert.equal(f.memory.snapshot().events.length, 1);
});
