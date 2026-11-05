import type {
  Account,
  Binding,
  CanonicalSession,
  NativeBindingReference,
  Result,
  SessionPersistence,
  SessionTransaction,
  TerminalState,
} from "./contracts";
import { NativeCredentialPolicy, type Principal } from "./policy";
import {
  accountId,
  attemptId,
  bindingReference,
  data,
  digest,
  matchesProof,
  sessionId,
  time,
} from "./values";

const rejected = (code: Extract<Result, { kind: "rejected" }>["code"]): Result =>
  Object.freeze({ kind: "rejected", code });
const conflict = (): Result =>
  Object.freeze({ kind: "conflict", code: "IMMUTABLE_BINDING_CONFLICT" });
const unavailable = (): Result =>
  Object.freeze({ kind: "unavailable", code: "AUTHORITY_UNAVAILABLE" });
const terminal = (b: Binding, state: TerminalState): Result =>
  Object.freeze({ kind: "terminal", state, nativeBindingReference: b.nativeBindingReference });
function isTerminal(state: Binding["state"]): state is TerminalState {
  return state === "CANCELLED" || state === "EXPIRED" || state === "REVOKED";
}

/** Account-access domain only. There is deliberately no provider verifier, HTTP composition or economic port. */
export class NativeSessionCore {
  readonly productionReady = false;
  readonly #sessionLifetimeMs: number;
  constructor(
    private readonly persistence: SessionPersistence,
    private readonly policy: NativeCredentialPolicy,
    sessionLifetimeMs: number,
  ) {
    this.#sessionLifetimeMs = time(sessionLifetimeMs);
    if (!sessionLifetimeMs || sessionLifetimeMs > 86_400_000)
      throw new Error("Explicit bounded session lifetime required");
  }

  async complete(input: unknown): Promise<Result> {
    let request: Readonly<Record<string, unknown>>;
    let id: ReturnType<typeof attemptId>, secret: string;
    try {
      request = data(input, ["loginAttemptId", "evidence", "accessSecret"]);
      id = attemptId(request.loginAttemptId);
      secret = digest(request.accessSecret);
    } catch {
      return rejected("INVALID_REQUEST");
    }
    try {
      const principal = await this.policy.inspect(request.evidence);
      if (!principal) return rejected("AUTHENTICATION_REJECTED");
      const reference = await this.persistence.bindingForAttempt(id);
      if (!reference) return rejected("SESSION_NOT_BOUND");
      return await this.persistence.transaction(reference, async (tx) => {
        const b = await tx.binding();
        if (!b || b.loginAttemptId !== id || b.nativeBindingReference !== reference)
          return rejected("SESSION_NOT_BOUND");
        return this.access(tx, b, principal, secret, true);
      });
    } catch {
      return unavailable();
    }
  }

  async validate(input: unknown): Promise<Result> {
    let request: Readonly<Record<string, unknown>>,
      reference: NativeBindingReference,
      secret: string;
    try {
      request = data(input, ["nativeBindingReference", "evidence", "accessSecret"]);
      reference = bindingReference(request.nativeBindingReference);
      secret = digest(request.accessSecret);
    } catch {
      return rejected("INVALID_REQUEST");
    }
    try {
      const principal = await this.policy.inspect(request.evidence);
      if (!principal) return rejected("AUTHENTICATION_REJECTED");
      return await this.persistence.transaction(reference, async (tx) => {
        const b = await tx.binding();
        if (!b || b.nativeBindingReference !== reference) return rejected("SESSION_NOT_BOUND");
        return this.access(tx, b, principal, secret, false);
      });
    } catch {
      return unavailable();
    }
  }

  /** Capability-only operation: cancellation before completion, revocation afterwards. */
  async revoke(input: unknown): Promise<Result> {
    let reference: NativeBindingReference, secret: string;
    try {
      const request = data(input, ["nativeBindingReference", "revocationSecret"]);
      reference = bindingReference(request.nativeBindingReference);
      secret = digest(request.revocationSecret);
    } catch {
      return rejected("INVALID_REQUEST");
    }
    try {
      return await this.persistence.transaction(reference, async (tx) => {
        const b = await tx.binding();
        // Unknown reference and wrong capability intentionally have the same result.
        if (!b || b.nativeBindingReference !== reference || !matchesProof("revocation", b, secret))
          return rejected("INVALID_PROOF");
        const canonical = await this.lockCanonical(tx, b);
        // A committed terminal record needs no new timestamp and never re-runs canonical revocation.
        if (isTerminal(b.state)) return terminal(b, b.state);
        const now = await this.observe(tx, b, canonical);
        if (canonical && canonical.session.revokedAt !== null)
          return this.end(tx, b, "REVOKED", now);
        if (b.state === "PENDING")
          return this.end(tx, b, now >= time(b.attemptExpiresAt) ? "EXPIRED" : "CANCELLED", now);
        if (!canonical) throw new Error("Missing canonical session");
        if (now >= canonical.session.expiresAt) return this.end(tx, b, "EXPIRED", now);
        await tx.revokeSession(canonical.account, canonical.session, now);
        return this.end(tx, b, "REVOKED", now);
      });
    } catch {
      return unavailable();
    }
  }

  private async access(
    tx: SessionTransaction,
    b: Binding,
    principal: Principal,
    secret: string,
    completing: boolean,
  ): Promise<Result> {
    const { authentication: a, policy: p } = principal;
    if (!matchesProof("access", b, secret)) return rejected("INVALID_PROOF");
    if (
      p.environment !== b.context.environment ||
      a.issuer !== b.context.issuer ||
      a.azp !== b.context.clientId ||
      p.audience !== b.context.audience
    )
      return rejected("ACCESS_DENIED");
    if (b.owner && (b.owner.issuer !== a.issuer || b.owner.subject !== a.subject))
      return conflict();
    let canonical = await this.lockCanonical(tx, b);
    let account: Account | null = canonical?.account ?? null;
    // Resolve only an existing mapping, never invoke provisioning. Lock account before session.
    if (completing && b.state === "PENDING") {
      const existing = await tx.resolveExisting(a.issuer, a.subject);
      if (existing) account = await tx.lockAccount(existing);
    }
    const now = await this.observe(tx, b, canonical, account);
    const denial = this.policy.authorize(
      principal,
      completing ? "native-bootstrap" : "native-account",
      now,
    );
    if (denial) return denial;
    if (isTerminal(b.state)) return terminal(b, b.state);
    if (canonical && canonical.session.revokedAt !== null) return this.end(tx, b, "REVOKED", now);
    if (now >= time(canonical?.session.expiresAt ?? b.attemptExpiresAt))
      return this.end(tx, b, "EXPIRED", now);
    if (
      completing &&
      (a.grant !== "authorization_code" ||
        a.bootstrap?.loginAttemptId !== b.loginAttemptId ||
        a.bootstrap.challenge !== b.challenge)
    )
      return rejected("BOOTSTRAP_REQUIRED");
    if (!account) return rejected(completing ? "ACCOUNT_NOT_PROVISIONED" : "SESSION_NOT_BOUND");
    this.assertAccount(account);
    if (account.status !== "ACTIVE") return rejected("ACCESS_DENIED");
    if (!canonical) {
      if (
        !completing ||
        b.state !== "PENDING" ||
        b.attemptState !== "PENDING" ||
        b.owner ||
        b.canonicalAccountSessionId
      )
        throw new Error("Invalid pending binding");
      const expiresAt = time(now + this.#sessionLifetimeMs);
      const session = await tx.createSession(account, now, expiresAt);
      sessionId(session.canonicalAccountSessionId);
      if (
        session.accountId !== account.accountId ||
        session.createdAt !== now ||
        session.expiresAt !== expiresAt ||
        session.revokedAt !== null
      )
        throw new Error("Invalid canonical creation");
      const active: Binding = Object.freeze({
        ...b,
        state: "ACTIVE",
        attemptState: "COMPLETED",
        lastObservedAt: now,
        owner: Object.freeze({
          issuer: a.issuer,
          subject: a.subject,
          accountId: account.accountId,
        }),
        canonicalAccountSessionId: session.canonicalAccountSessionId,
      });
      await tx.saveBinding(active);
      canonical = { account, session };
    } else {
      await tx.saveBinding(Object.freeze({ ...b, lastObservedAt: now }));
    }
    return Object.freeze({
      kind: "account-access",
      identity: Object.freeze({ issuer: a.issuer, subject: a.subject }),
      account: Object.freeze({ accountId: account.accountId, actorSubject: account.actorSubject }),
      nativeBindingReference: b.nativeBindingReference,
      canonicalAccountSessionId: canonical.session.canonicalAccountSessionId,
      expiresAt: canonical.session.expiresAt,
      observedAt: now,
      economicAuthority: "unavailable",
    });
  }

  private assertAccount(account: Account): void {
    if (
      account.actorSubject !== `zp:account:${accountId(account.accountId)}` ||
      typeof account.version !== "bigint" ||
      account.version < 0n
    )
      throw new Error("Invalid canonical account");
  }
  private async lockCanonical(
    tx: SessionTransaction,
    b: Binding,
  ): Promise<{ account: Account; session: CanonicalSession } | null> {
    if (!b.canonicalAccountSessionId) {
      if (
        b.owner ||
        b.state === "ACTIVE" ||
        b.state === "REVOKED" ||
        b.attemptState === "COMPLETED"
      )
        throw new Error("Incomplete canonical mapping");
      return null;
    }
    if (
      !b.owner ||
      b.attemptState !== "COMPLETED" ||
      b.state === "PENDING" ||
      b.state === "CANCELLED"
    )
      throw new Error("Invalid canonical mapping");
    const account = await tx.lockAccount(b.owner.accountId);
    this.assertAccount(account);
    const session = await tx.lockSession(b.canonicalAccountSessionId);
    sessionId(session.canonicalAccountSessionId);
    if (
      account.accountId !== b.owner.accountId ||
      session.accountId !== account.accountId ||
      session.canonicalAccountSessionId !== b.canonicalAccountSessionId ||
      time(session.expiresAt) <= time(session.createdAt) ||
      (session.revokedAt !== null && time(session.revokedAt) < session.createdAt)
    )
      throw new Error("Session ownership mismatch");
    return { account, session };
  }
  private async observe(
    tx: SessionTransaction,
    b: Binding,
    canonical: { account: Account; session: CanonicalSession } | null,
    account: Account | null = null,
  ): Promise<number> {
    const now = time(await tx.observeTime());
    if (
      now < time(b.lastObservedAt) ||
      now < time(b.createdAt) ||
      (account && now < time(account.updatedAt)) ||
      (canonical &&
        (now < time(canonical.account.updatedAt) || now < time(canonical.session.createdAt)))
    )
      throw new Error("Clock authority unavailable");
    return now;
  }
  private async end(
    tx: SessionTransaction,
    b: Binding,
    state: TerminalState,
    now: number,
  ): Promise<Result> {
    const next: Binding = Object.freeze({
      ...b,
      state,
      lastObservedAt: now,
      attemptState:
        b.attemptState === "COMPLETED"
          ? "COMPLETED"
          : state === "CANCELLED"
            ? "CANCELLED"
            : "EXPIRED",
    });
    await tx.saveBinding(next);
    // Return data, not an exception: the persistence boundary must commit this transition.
    return terminal(next, state);
  }
}
