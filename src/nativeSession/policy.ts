import type {
  Authentication,
  AuthenticationPort,
  Bootstrap,
  ClientPolicy,
  Result,
  RouteClass,
} from "./contracts";
import { attemptId, data, digest, owns, strings, text, time } from "./values";

export type Principal = Readonly<{ authentication: Authentication; policy: ClientPolicy }>;
type Denial = Extract<Result, { kind: "rejected" }>;
const denied = (): Denial => Object.freeze({ kind: "rejected", code: "ACCESS_DENIED" });

/** Unmounted policy. Caller labels cannot select a credential class or override a registered client. */
export class NativeCredentialPolicy {
  readonly #clients: readonly ClientPolicy[];
  readonly #issued = new WeakSet<object>();
  constructor(
    private readonly authentication: AuthenticationPort,
    clients: readonly ClientPolicy[],
  ) {
    this.#clients = Object.freeze(
      clients.map((input) => {
        const p = data(input, [
          "environment",
          "issuer",
          "clientId",
          "audience",
          "credentialClass",
          "scopes",
          "maxTokenLifetimeMs",
        ]);
        if (!["native-user", "legacy-web", "service"].includes(p.credentialClass as string))
          throw new Error("Unknown credential class");
        const issuer = text(p.issuer),
          audience = text(p.audience),
          clientId = text(p.clientId);
        const url = new URL(issuer);
        if (
          url.protocol !== "https:" ||
          url.href !== issuer ||
          url.pathname !== "/" ||
          url.search ||
          url.hash ||
          url.username ||
          url.password ||
          url.port ||
          audience === clientId ||
          audience === `${issuer}userinfo`
        )
          throw new Error("Invalid provider policy");
        const lifetime = time(p.maxTokenLifetimeMs);
        if (lifetime === 0 || lifetime > 86_400_000) throw new Error("Invalid token lifetime");
        return Object.freeze({
          environment: text(p.environment),
          issuer,
          clientId,
          audience,
          credentialClass: p.credentialClass as ClientPolicy["credentialClass"],
          scopes: strings(p.scopes),
          maxTokenLifetimeMs: lifetime,
        });
      }),
    );
    const identities = this.#clients.map((p) => JSON.stringify([p.issuer, p.clientId]));
    if (new Set(identities).size !== identities.length) throw new Error("Ambiguous client policy");
  }
  async inspect(evidence: unknown): Promise<Principal | null> {
    // Adapter exceptions are unavailability, never an authentication fallback.
    const input = await this.authentication.resolve(evidence);
    if (input === null) return null;
    try {
      const c = data(
        input,
        ["issuer", "subject", "azp", "audience", "scopes", "issuedAt", "expiresAt", "grant"],
        ["bootstrap"],
      );
      const issuer = text(c.issuer),
        azp = text(c.azp),
        subject = text(c.subject);
      const policy = this.#clients.find((p) => p.issuer === issuer && p.clientId === azp);
      if (
        !policy ||
        !["authorization_code", "refresh_token", "client_credentials"].includes(c.grant as string)
      )
        return null;
      const audience = strings(c.audience),
        scopes = strings(c.scopes);
      if (
        !audience.includes(policy.audience) ||
        audience.some((a) => a !== policy.audience && a !== `${issuer}userinfo`) ||
        scopes.some((scope) => !policy.scopes.includes(scope))
      )
        return null;
      if (
        policy.credentialClass === "service"
          ? c.grant !== "client_credentials"
          : c.grant === "client_credentials" || subject.endsWith("@clients")
      )
        return null;
      let bootstrap: Bootstrap | undefined;
      if (owns(c, "bootstrap")) {
        const b = data(c.bootstrap, ["version", "loginAttemptId", "challenge"]);
        if (
          b.version !== 1 ||
          c.grant !== "authorization_code" ||
          policy.credentialClass !== "native-user"
        )
          return null;
        bootstrap = Object.freeze({
          version: 1,
          loginAttemptId: attemptId(b.loginAttemptId),
          challenge: digest(b.challenge),
        });
      }
      const authentication: Authentication = Object.freeze({
        issuer,
        subject,
        azp,
        audience,
        scopes,
        issuedAt: time(c.issuedAt),
        expiresAt: time(c.expiresAt),
        grant: c.grant as Authentication["grant"],
        ...(bootstrap ? { bootstrap } : {}),
      });
      if (
        authentication.expiresAt <= authentication.issuedAt ||
        authentication.expiresAt - authentication.issuedAt > policy.maxTokenLifetimeMs
      )
        return null;
      const principal = Object.freeze({ authentication, policy });
      this.#issued.add(principal);
      return principal;
    } catch {
      return null;
    }
  }
  authorize(principal: Principal, route: RouteClass, now: number): Denial | null {
    if (!this.#issued.has(principal)) return denied();
    time(now);
    const { authentication: a, policy: p } = principal;
    if (a.issuedAt > now)
      return Object.freeze({ kind: "rejected", code: "AUTHENTICATION_REJECTED" });
    if (a.expiresAt <= now)
      return Object.freeze({ kind: "rejected", code: "ACCESS_TOKEN_EXPIRED" });
    const required: Partial<
      Record<RouteClass, readonly [ClientPolicy["credentialClass"], ...string[]]>
    > = {
      "native-bootstrap": ["native-user", "native:session", "read:account"],
      "native-account": ["native-user", "native:session", "read:account"],
      "legacy-account": ["legacy-web", "read:account"],
      "legacy-payment": ["legacy-web", "read:payments"],
      service: ["service", "service:read"],
    };
    const rule = owns(required, route) ? required[route] : undefined;
    if (
      !rule ||
      rule[0] !== p.credentialClass ||
      rule.slice(1).some((scope) => !a.scopes.includes(scope))
    )
      return denied();
    return null;
  }
}
