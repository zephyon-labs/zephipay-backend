import type { IdentityPersistence } from "../../identity/identityStorageContracts";
import type { ExternalPrincipal } from "../../auth/externalPrincipal";
import { EconomicSessionAdministration } from "../foundation/sessionAuthority";
import { requireCondition } from "../foundation/database";

/** Internal adapter for the existing identity service. Inputs must come from verified provider authentication. */
export class CanonicalEconomicSessionService {
  constructor(private readonly identities: IdentityPersistence, private readonly bindings: EconomicSessionAdministration,
    private readonly trustedIssuer: string) {}

  async bindExisting(input: { principal: ExternalPrincipal; accountSessionId: string; assertedTokenIssuedAt: string }): Promise<void> {
    const {principal}=input;
    requireCondition(principal.issuer===this.trustedIssuer && principal.providerSessionId,"Verified issuer/session context required.");
    const resolved=await this.identities.findAccountByExternalIdentity(principal.issuer,principal.providerSubject);
    const session=await this.identities.findAccountSession(input.accountSessionId);
    requireCondition(resolved?.account.status==="ACTIVE" && session?.accountId===resolved.account.accountId,"Canonical session/account mismatch.");
    requireCondition(Number.isFinite(Date.parse(input.assertedTokenIssuedAt)) && Date.parse(session.createdAt)<=Date.parse(input.assertedTokenIssuedAt),"Authentication predates canonical session.");
    await this.bindings.bind({issuer:principal.issuer,providerSubject:principal.providerSubject,providerSessionReference:principal.providerSessionId,accountSessionId:session.sessionId});
  }

  // Existing account version CAS and security-event transaction remain authoritative.
  create(input: Parameters<IdentityPersistence["createAccountSession"]>[0]) { return this.identities.createAccountSession(input); }
  revoke(input: Parameters<IdentityPersistence["revokeAccountSession"]>[0]) { return this.identities.revokeAccountSession(input); }
}
