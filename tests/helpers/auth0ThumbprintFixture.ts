import { providerJwks } from "./providerTokens";

// Public example from Auth0's documentation, NOT evidence of the deployed tenant's representation.
export const AUTH0_THUMBPRINT_SOURCE = "https://auth0.com/docs/secure/tokens/json-web-tokens/json-web-key-set-properties";
export const AUTH0_DOCUMENTED_X5T = "NjVBRjY5MDlCMUIwNzU4RTA2QzZFMDQ4QzQ2MDAyQjVDNjk1RTM2Qg";
export const AUTH0_DOCUMENTED_X5T_HEX = "65AF6909B1B0758E06C6E048C46002B5C695E36B";

export function documentedAuth0ThumbprintJwks() {
  const jwks = structuredClone(providerJwks);
  // Intentionally unrelated to the fixture RSA key: metadata is never a verification trust path.
  jwks.keys[0].x5t = AUTH0_DOCUMENTED_X5T;
  return jwks;
}
