/** TEST ONLY. Coarse serial transactions and opaque synthetic evidence; no database/network/keys. */
import type {
  Account,
  AuthenticationPort,
  Binding,
  CanonicalAccountSessionId,
  CanonicalSession,
  ClientPolicy,
  LoginAttemptId,
  NativeBindingReference,
  SessionPersistence,
  SessionTransaction,
} from "../../src/nativeSession/contracts";
import { NativeSessionCore } from "../../src/nativeSession/core";
import { NativeCredentialPolicy } from "../../src/nativeSession/policy";
import {
  attemptId,
  bindingReference,
  proofCommitment,
  sessionId,
} from "../../src/nativeSession/values";

export const START = 1_800_000_000_000;
export const ACCOUNT = "00000000-0000-4000-8000-000000000101";
export const OTHER_ACCOUNT = "00000000-0000-4000-8000-000000000102";
export const ACCESS = "11".repeat(32),
  REVOCATION = "22".repeat(32);
export const CLIENT: ClientPolicy = Object.freeze({
  environment: "offline-test",
  issuer: "https://issuer.invalid/",
  clientId: "native-test",
  audience: "https://native.invalid/",
  credentialClass: "native-user",
  scopes: Object.freeze(["openid", "native:session", "read:account"]),
  maxTokenLifetimeMs: 300_000,
});
export const WEB: ClientPolicy = {
  ...CLIENT,
  clientId: "web-test",
  audience: "https://legacy.invalid/",
  credentialClass: "legacy-web",
  scopes: ["read:account", "read:payments"],
};
export const SERVICE: ClientPolicy = {
  ...CLIENT,
  clientId: "service-test",
  audience: "https://service.invalid/",
  credentialClass: "service",
  scopes: ["service:read"],
};

export class SyntheticAuthentication implements AuthenticationPort {
  readonly #evidence = new WeakMap<object, unknown>();
  fail = false;
  issue(claims: unknown): object {
    const handle = Object.freeze({});
    this.#evidence.set(handle, claims);
    return handle;
  }
  async resolve(handle: unknown): Promise<unknown | null> {
    if (this.fail) throw new Error("Injected verifier outage");
    return typeof handle === "object" && handle !== null
      ? (this.#evidence.get(handle) ?? null)
      : null;
  }
}
type Event = {
  type: "SESSION_CREATED" | "SESSION_REVOKED";
  accountId: string;
  sessionId: string;
  accountVersion: bigint;
  occurredAt: number;
};
type Store = {
  bindings: Map<string, Binding>;
  accounts: Map<string, Account>;
  identities: Map<string, string>;
  sessions: Map<string, CanonicalSession>;
  events: Event[];
};
type Fault =
  | "binding-lock"
  | "account-lock"
  | "session-lock"
  | "before-commit"
  | "after-commit"
  | "after-create"
  | "after-revoke"
  | "after-save";

export class MemorySessionHarness implements SessionPersistence {
  #store: Store = {
    bindings: new Map(),
    accounts: new Map(),
    identities: new Map(),
    sessions: new Map(),
    events: [],
  };
  #tail: Promise<void> = Promise.resolve();
  #nextSession = 0;
  fault: Fault | null = null;
  now = START;
  clock: () => number = () => this.now;
  beforeClock: (() => Promise<void>) | null = null;
  readonly traces: string[][] = [];
  seedAccount(id = ACCOUNT, subject = "alice", issuer = CLIENT.issuer): void {
    if (
      this.#store.accounts.has(id) ||
      this.#store.identities.has(JSON.stringify([issuer, subject]))
    )
      throw new Error("Duplicate seed");
    this.#store.accounts.set(id, {
      accountId: id,
      actorSubject: `zp:account:${id}`,
      status: "ACTIVE",
      version: 0n,
      updatedAt: START,
    });
    this.#store.identities.set(JSON.stringify([issuer, subject]), id);
  }
  seedBinding(index = 1, changes: Partial<Binding> = {}): Binding {
    const hex = index.toString(16).padStart(32, "0");
    const context = {
      environment: CLIENT.environment,
      issuer: CLIENT.issuer,
      clientId: CLIENT.clientId,
      audience: CLIENT.audience,
    };
    const base = { context, creationKey: hex.repeat(2) };
    const b: Binding = {
      ...base,
      loginAttemptId: attemptId(`attempt_${hex}`),
      nativeBindingReference: bindingReference(`binding_${hex}`),
      challenge: "33".repeat(32),
      accessCommitment: proofCommitment("access", base, ACCESS),
      revocationCommitment: proofCommitment("revocation", base, REVOCATION),
      createdAt: START,
      attemptExpiresAt: START + 300_000,
      lastObservedAt: START,
      state: "PENDING",
      attemptState: "PENDING",
      ...changes,
    };
    if (
      [...this.#store.bindings.values()].some(
        (v) =>
          v.loginAttemptId === b.loginAttemptId ||
          v.nativeBindingReference === b.nativeBindingReference,
      )
    )
      throw new Error("Duplicate seed");
    this.#store.bindings.set(b.nativeBindingReference, structuredClone(b));
    return structuredClone(b);
  }
  snapshot(): Store {
    return structuredClone(this.#store);
  }
  setAccountStatus(status: Account["status"], id = ACCOUNT): void {
    const a = this.#store.accounts.get(id)!;
    this.#store.accounts.set(id, { ...a, status });
  }
  async bindingForAttempt(id: LoginAttemptId): Promise<NativeBindingReference | null> {
    return (
      [...this.#store.bindings.values()].find((b) => b.loginAttemptId === id)
        ?.nativeBindingReference ?? null
    );
  }
  async transaction<T>(
    reference: NativeBindingReference,
    body: (tx: SessionTransaction) => Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const prior = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    const trace = [`binding:${reference}:exclusive`];
    this.traces.push(trace);
    const working = structuredClone(this.#store);
    let lockedAccount: string | null = null,
      lockedSession: string | null = null;
    const fail = (point: Fault) => {
      if (this.fault === point) {
        this.fault = null;
        throw new Error(`Injected ${point}`);
      }
    };
    const requireAccount = (id: string) => {
      if (lockedAccount !== id) throw new Error("Account must be exclusively locked first");
    };
    const tx: SessionTransaction = {
      binding: async () => structuredClone(working.bindings.get(reference) ?? null),
      resolveExisting: async (issuer, subject) =>
        working.identities.get(JSON.stringify([issuer, subject])) ?? null,
      lockAccount: async (id) => {
        fail("account-lock");
        if (lockedSession || (lockedAccount && lockedAccount !== id))
          throw new Error("Account-before-session order violated");
        lockedAccount = id;
        trace.push(`account:${id}:exclusive`);
        const a = working.accounts.get(id);
        if (!a) throw new Error("Missing account");
        return structuredClone(a);
      },
      lockSession: async (id) => {
        fail("session-lock");
        const s = working.sessions.get(id);
        if (!s) throw new Error("Missing session");
        requireAccount(s.accountId);
        if (lockedSession && lockedSession !== id) throw new Error("Multiple session locks");
        lockedSession = id;
        trace.push(`session:${id}:exclusive`);
        return structuredClone(s);
      },
      observeTime: async () => {
        if (this.beforeClock) {
          const hook = this.beforeClock;
          this.beforeClock = null;
          await hook();
        }
        trace.push("clock");
        return this.clock();
      },
      saveBinding: async (b) => {
        const old = working.bindings.get(reference);
        if (!old) throw new Error("No upsert on recovery");
        for (const key of [
          "loginAttemptId",
          "nativeBindingReference",
          "creationKey",
          "challenge",
          "accessCommitment",
          "revocationCommitment",
          "createdAt",
          "attemptExpiresAt",
        ] as const)
          if (old[key] !== b[key]) throw new Error("Immutable binding changed");
        if (
          JSON.stringify(old.context) !== JSON.stringify(b.context) ||
          b.lastObservedAt < old.lastObservedAt
        )
          throw new Error("Immutable context/clock changed");
        if (["CANCELLED", "EXPIRED", "REVOKED"].includes(old.state) && b.state !== old.state)
          throw new Error("Terminal binding revived");
        if (
          old.state === "ACTIVE" &&
          b.state !== "ACTIVE" &&
          b.state !== "EXPIRED" &&
          b.state !== "REVOKED"
        )
          throw new Error("Invalid active transition");
        if (old.attemptState !== "PENDING" && b.attemptState !== old.attemptState)
          throw new Error("Attempt revived");
        if (
          old.owner &&
          (JSON.stringify(old.owner) !== JSON.stringify(b.owner) ||
            old.canonicalAccountSessionId !== b.canonicalAccountSessionId)
        )
          throw new Error("Owner rebound");
        working.bindings.set(reference, structuredClone(b));
        trace.push(`save:${b.state}`);
        fail("after-save");
      },
      createSession: async (a, createdAt, expiresAt) => {
        requireAccount(a.accountId);
        if (
          working.bindings.get(reference)?.state !== "PENDING" ||
          lockedSession ||
          expiresAt <= createdAt
        )
          throw new Error("Invalid creation");
        const current = working.accounts.get(a.accountId)!;
        if (
          current.version !== a.version ||
          current.status !== "ACTIVE" ||
          createdAt < current.updatedAt
        )
          throw new Error("Stale account");
        const id = sessionId(
          `00000000-0000-4000-8000-${(++this.#nextSession).toString(16).padStart(12, "0")}`,
        );
        lockedSession = id;
        trace.push(`session:${id}:exclusive`);
        const s: CanonicalSession = {
          canonicalAccountSessionId: id,
          accountId: a.accountId,
          createdAt,
          expiresAt,
          revokedAt: null,
        };
        working.sessions.set(id, s);
        working.accounts.set(a.accountId, {
          ...current,
          version: current.version + 1n,
          updatedAt: createdAt,
        });
        working.events.push({
          type: "SESSION_CREATED",
          accountId: a.accountId,
          sessionId: id,
          accountVersion: current.version + 1n,
          occurredAt: createdAt,
        });
        trace.push("create");
        fail("after-create");
        return structuredClone(s);
      },
      revokeSession: async (a, s, at) => {
        requireAccount(a.accountId);
        const current = working.accounts.get(a.accountId)!,
          stored = working.sessions.get(s.canonicalAccountSessionId)!;
        if (
          lockedSession !== s.canonicalAccountSessionId ||
          stored.accountId !== a.accountId ||
          stored.revokedAt !== null ||
          current.version !== a.version ||
          at < current.updatedAt ||
          at < stored.createdAt
        )
          throw new Error("Invalid non-idempotent revocation");
        working.sessions.set(s.canonicalAccountSessionId, { ...stored, revokedAt: at });
        working.accounts.set(a.accountId, {
          ...current,
          version: current.version + 1n,
          updatedAt: at,
        });
        working.events.push({
          type: "SESSION_REVOKED",
          accountId: a.accountId,
          sessionId: s.canonicalAccountSessionId,
          accountVersion: current.version + 1n,
          occurredAt: at,
        });
        trace.push("revoke");
        fail("after-revoke");
      },
    };
    try {
      fail("binding-lock");
      const result = await body(tx);
      fail("before-commit");
      this.#store = working;
      trace.push("commit");
      fail("after-commit");
      return result;
    } catch (error) {
      trace.push(trace.includes("commit") ? "response-lost" : "rollback");
      throw error;
    } finally {
      release();
    }
  }
}

export function fixture() {
  const memory = new MemorySessionHarness(),
    auth = new SyntheticAuthentication();
  memory.seedAccount();
  const b = memory.seedBinding();
  const policy = new NativeCredentialPolicy(auth, [CLIENT, WEB, SERVICE]);
  const core = new NativeSessionCore(memory, policy, 86_400_000);
  const claims = (changes: Record<string, unknown> = {}) => ({
    issuer: CLIENT.issuer,
    subject: "alice",
    azp: CLIENT.clientId,
    audience: [CLIENT.audience],
    scopes: [...CLIENT.scopes],
    issuedAt: memory.now,
    expiresAt: memory.now + 300_000,
    grant: "authorization_code",
    bootstrap: { version: 1, loginAttemptId: b.loginAttemptId, challenge: b.challenge },
    ...changes,
  });
  const evidence = auth.issue(claims());
  const complete = (handle = evidence) =>
    core.complete({ loginAttemptId: b.loginAttemptId, accessSecret: ACCESS, evidence: handle });
  const validate = (handle = evidence) =>
    core.validate({
      nativeBindingReference: b.nativeBindingReference,
      accessSecret: ACCESS,
      evidence: handle,
    });
  const revoke = () =>
    core.revoke({ nativeBindingReference: b.nativeBindingReference, revocationSecret: REVOCATION });
  return { memory, auth, b, policy, core, claims, evidence, complete, validate, revoke };
}
