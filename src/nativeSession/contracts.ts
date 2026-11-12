/** Offline, unmounted domain contracts. No HTTP, JWT verifier, database adapter or composition. */
declare const identifier: unique symbol;
export type LoginAttemptId = string & { readonly [identifier]: "login-attempt" };
export type NativeBindingReference = string & { readonly [identifier]: "native-binding" };
export type CanonicalAccountSessionId = string & { readonly [identifier]: "canonical-session" };

export type CredentialClass = "native-user" | "legacy-web" | "service";
export type RouteClass =
  "native-account" | "native-bootstrap" | "legacy-account" | "legacy-payment" | "service";
export type ClientPolicy = Readonly<{
  environment: string;
  issuer: string;
  clientId: string;
  audience: string;
  credentialClass: CredentialClass;
  scopes: readonly string[];
  maxTokenLifetimeMs: number;
}>;
export type Bootstrap = Readonly<{ version: 1; loginAttemptId: LoginAttemptId; challenge: string }>;
export type Authentication = Readonly<{
  issuer: string;
  subject: string;
  azp: string;
  audience: readonly string[];
  scopes: readonly string[];
  issuedAt: number;
  expiresAt: number;
  grant: "authorization_code" | "refresh_token" | "client_credentials";
  bootstrap?: Bootstrap;
}>;
/** Trusted adapter seam, NOT token verification. The only adapter supplied is under tests/helpers. */
export interface AuthenticationPort {
  resolve(evidence: unknown): Promise<unknown | null>;
}

export type Context = Readonly<
  Pick<ClientPolicy, "environment" | "issuer" | "clientId" | "audience">
>;
export type TerminalState = "CANCELLED" | "EXPIRED" | "REVOKED";
export type Binding = Readonly<{
  loginAttemptId: LoginAttemptId;
  nativeBindingReference: NativeBindingReference;
  context: Context;
  creationKey: string;
  challenge: string;
  accessCommitment: string;
  revocationCommitment: string;
  createdAt: number;
  attemptExpiresAt: number;
  lastObservedAt: number;
  attemptState: "PENDING" | "COMPLETED" | "CANCELLED" | "EXPIRED";
  state: "PENDING" | "ACTIVE" | TerminalState;
  owner?: Readonly<{ issuer: string; subject: string; accountId: string }>;
  canonicalAccountSessionId?: CanonicalAccountSessionId;
}>;
export type Account = Readonly<{
  accountId: string;
  actorSubject: string;
  status: "ACTIVE" | "SUSPENDED" | "DELETION_PENDING" | "DELETED";
  version: bigint;
  updatedAt: number;
}>;
export type CanonicalSession = Readonly<{
  canonicalAccountSessionId: CanonicalAccountSessionId;
  accountId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}>;

/**
 * Caller already holds the binding's exclusive serialization lock. No lock upgrades.
 * Returned records are validated/snapshotted by the core; TypeScript types alone
 * do not establish identity or authority. Adapters must keep serialized state
 * stable throughout the callback and commit all its writes atomically.
 */
export interface SessionTransaction {
  binding(): Promise<Binding | null>;
  resolveExisting(issuer: string, subject: string): Promise<string | null>;
  lockAccount(accountId: string): Promise<Account>;
  lockSession(id: CanonicalAccountSessionId): Promise<CanonicalSession>;
  observeTime(): Promise<number>;
  saveBinding(binding: Binding): Promise<void>;
  /** Must perform the version increment and security event atomically with session creation. */
  createSession(account: Account, createdAt: number, expiresAt: number): Promise<CanonicalSession>;
  /** Non-idempotent canonical operation: domain must inspect current state first. */
  revokeSession(account: Account, session: CanonicalSession, revokedAt: number): Promise<void>;
}
export interface SessionPersistence {
  /** Immutable index lookup only; never creates or returns authority. */
  bindingForAttempt(id: LoginAttemptId): Promise<NativeBindingReference | null>;
  /** Resolve only AFTER commit acknowledgement. Throw on rollback or ambiguous commit. */
  transaction<T>(
    reference: NativeBindingReference,
    body: (tx: SessionTransaction) => Promise<T>,
  ): Promise<T>;
}

export type Result =
  | Readonly<{
      kind: "account-access";
      identity: Readonly<{ issuer: string; subject: string }>;
      account: Readonly<{ accountId: string; actorSubject: string }>;
      nativeBindingReference: NativeBindingReference;
      canonicalAccountSessionId: CanonicalAccountSessionId;
      expiresAt: number;
      observedAt: number;
      economicAuthority: "unavailable";
    }>
  | Readonly<{
      kind: "terminal";
      state: TerminalState;
      nativeBindingReference: NativeBindingReference;
    }>
  | Readonly<{
      kind: "rejected";
      code:
        | "INVALID_REQUEST"
        | "AUTHENTICATION_REJECTED"
        | "ACCESS_DENIED"
        | "ACCESS_TOKEN_EXPIRED"
        | "INVALID_PROOF"
        | "SESSION_NOT_BOUND"
        | "ACCOUNT_NOT_PROVISIONED"
        | "BOOTSTRAP_REQUIRED";
    }>
  | Readonly<{ kind: "conflict"; code: "IMMUTABLE_BINDING_CONFLICT" }>
  | Readonly<{ kind: "unavailable"; code: "AUTHORITY_UNAVAILABLE" }>;
