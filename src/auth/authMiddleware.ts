import type { NextFunction, Request, Response } from "express";
import { auth, InsufficientScopeError, requiredScopes, type PublicKeyInput } from "express-oauth2-jwt-bearer";

import type { ExternalPrincipal } from "./externalPrincipal";

export type AuthConfiguration = Readonly<{
  issuer: string; audience: string; requiredScope: string;
  publicKey?: PublicKeyInput;
}>;

export function createAuthPipeline(configuration: AuthConfiguration) {
  const issuerConfiguration = configuration.publicKey
    ? {
        issuer: configuration.issuer,
        publicKey: configuration.publicKey,
      }
    : {
        issuerBaseURL: configuration.issuer,
      };

  const verify = auth({
    ...issuerConfiguration,
    audience: configuration.audience,
    tokenSigningAlg: "RS256",
    clockTolerance: 5,
    // Auth0 currently emits `typ: JWT` for custom API access tokens. Exact API
    // audience validation distinguishes them from ID tokens.
    strict: false,
    validators: {
      typ: (value) => typeof value === "string" && ["jwt", "at+jwt"].includes(value.toLowerCase().replace(/^application\//, "")),
    },
    dpop: { enabled: false },
    timeoutDuration: 5_000,
    cacheMaxAge: 600_000,
  });
  const scope = requiredScopes(configuration.requiredScope);
  const authoritativeScopeClaim = (req: Request, _res: Response, next: NextFunction) => {
    if (typeof req.auth?.payload.scope !== "string") {
      next(new InsufficientScopeError([configuration.requiredScope], "Missing or malformed 'scope' claim"));
      return;
    }
    next();
  };
  return [verify, authoritativeScopeClaim, scope, normalizePrincipal] as const;
}

function normalizePrincipal(req: Request, res: Response, next: NextFunction): void {
  const claims = req.auth?.payload;
  if (!claims || typeof claims.iss !== "string" || typeof claims.sub !== "string") {
    next(new Error("Verified token did not contain a usable principal."));
    return;
  }
  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [];
  const principal: ExternalPrincipal = Object.freeze({
    issuer: claims.iss,
    providerSubject: claims.sub,
    ...(typeof claims.sid === "string" ? { providerSessionId: claims.sid } : {}),
    ...(typeof claims.auth_time === "number" ? { authenticatedAt: new Date(claims.auth_time * 1000).toISOString() } : {}),
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    ...(typeof claims.email_verified === "boolean" ? { emailVerified: claims.email_verified } : {}),
    ...(typeof claims.azp === "string" ? { authorizedClientId: claims.azp } : {}),
    scopes: Object.freeze(scopes),
  });
  res.locals.externalPrincipal = principal;
  next();
}

export function externalPrincipalFrom(res: Response): ExternalPrincipal {
  const principal = res.locals.externalPrincipal as ExternalPrincipal | undefined;
  if (!principal) throw new Error("Authentication principal is unavailable.");
  return principal;
}
