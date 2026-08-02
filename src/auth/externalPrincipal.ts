export type ExternalPrincipal = Readonly<{
  issuer: string;
  providerSubject: string;
  providerSessionId?: string;
  authenticatedAt?: string;
  email?: string;
  emailVerified?: boolean;
  authorizedClientId?: string;
  scopes: readonly string[];
}>;
