import { randomUUID } from "node:crypto";
import { databaseTime, requireCondition, sha256 } from "../foundation/database";
import { bindEconomicSession } from "../foundation/sessionAuthority";
import type { Auth0Authentication, ReauthenticationChallenge } from "../readiness/auth0Authentication";
import { ProviderDeploymentReadiness } from "../readiness/providerDeploymentReadiness";
import type { SignedArtifact } from "../readiness/signedArtifact";
import { assertConfirmationPolicy, type VerifiedConfirmationPolicy } from "./confirmationPolicy";
import { ConfirmationProofAuthority } from "./confirmationProofAuthority";

export type SdkSession = { user: { sub: string }; tokenSet: { accessToken: string; idToken?: string } };
type SdkCallback = (error: unknown, context: { returnTo?: string }, session?: SdkSession | null) => Promise<Response>;
/** Server-only host of the existing SDK's public middleware/onCallback/getSession APIs.
 * The host is trusted composition, never an HTTP body or a provider-validation replacement.
 * onCallback must be installed directly on Auth0Client; only its successful callback branch calls it.
 * The isolated real-SDK fixture demonstrates the exact host without mounting a live route.
 */
export type Auth0SdkHost = (onCallback: SdkCallback) => {
  start(returnTo: string): Promise<Response>;
  callback(request: Request): Promise<Response>;
};
export type ReadAuth0SdkSession = () => Promise<SdkSession | null>;
type BoundRow = {
  binding_id: string; challenge_id: string; state_digest: string; sdk_nonce: string; redirect_uri: string; return_to: string;
  context: { clientId: string; challenge: { reauthentication: ReauthenticationChallenge; transaction_id: string } };
  callback: null | { token_digest: string };
};
const resultPrefix = "/confirmation/auth0/result?binding=";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Unmounted non-value identity adapter. No signer, Runtime, settlement, or browser-claim endpoint.
 * Neither OIDC nonce nor PKCE/state/cookie contents are generated or rewritten here.
 * The SDK validates its transaction first; signed provider tokens and canonical DB truth are checked again.
 */
export class Auth0SdkConfirmationAdapter {
  private readonly proofs: ConfirmationProofAuthority;
  private readonly callbackUrl: URL;
  constructor(private readonly readiness: ProviderDeploymentReadiness, private readonly policy: VerifiedConfirmationPolicy,
    private readonly host: Auth0SdkHost, callbackUrl: string) {
    assertConfirmationPolicy(policy);
    this.proofs = new ConfirmationProofAuthority(readiness,policy);
    this.callbackUrl = new URL(callbackUrl);
    requireCondition(!this.callbackUrl.username && !this.callbackUrl.password && !this.callbackUrl.search && !this.callbackUrl.hash &&
      (this.callbackUrl.protocol === "https:" || (this.callbackUrl.protocol === "http:" && this.callbackUrl.hostname === "localhost")),
      "Explicit trusted SDK callback URL required.");
  }
  private async authentication(readSession: ReadAuth0SdkSession) {
    const session = await readSession();
    requireCondition(session?.tokenSet.accessToken && session.tokenSet.idToken, "Authenticated server SDK session required.");
    const authentication = await this.readiness.authentication.verifyAccess(session.tokenSet.accessToken,this.policy.policy.requiredScope);
    requireCondition(session.user.sub === authentication.subject, "SDK session/access subject mismatch.");
    return {session,authentication,providerSessionReference:`zephipay:sdk:${sha256(session.tokenSet.idToken)}`};
  }
  /** Existing trusted identity service selects the canonical session. This is not a browser session-creation API.
   * Persist the SDK-held ID-token reference through the existing immutable economic session binding authority.
   * Cookies and email never become economic identity; issuer+subject must own the canonical account/session.
   */
  async bindExistingSession(accountSessionId: string, readSession: ReadAuth0SdkSession, endpoint: SignedArtifact, endpointNonce: string) {
    const {authentication,providerSessionReference} = await this.authentication(readSession);
    await this.readiness.run(endpoint,endpointNonce,authentication,async client => {
      const session=(await client.query("SELECT created_at FROM account_sessions WHERE session_id=$1",[accountSessionId])).rows[0];
      requireCondition(session && session.created_at.getTime()/1000 <= authentication.issuedAt, "Authentication predates canonical session.");
      await bindEconomicSession(client,{issuer:authentication.issuer,providerSubject:authentication.subject,providerSessionReference,accountSessionId});
    });
  }
  private async bound(bindingId: string, authentication: Auth0Authentication, endpoint: SignedArtifact, nonce: string): Promise<BoundRow> {
    requireCondition(uuid.test(bindingId), "Explicit SDK binding reference required.");
    return this.readiness.run(endpoint,nonce,authentication,async client =>
      (await client.query("SELECT economic_read_confirmation_sdk($1,$2) AS binding",[bindingId,authentication])).rows[0].binding);
  }
  /** Challenge must already have been issued by the accepted canonical bridge. A browser may select a reference,
   * but issuer+subject, session, exact envelope, policy, configuration and expiry are all independently rechecked.
   * Commit the binding before releasing the SDK authorization redirect and encrypted transaction cookie.
   */
  async start(challengeId: string, readSession: ReadAuth0SdkSession, endpoint: SignedArtifact, endpointNonce: string) {
    const bindingId = randomUUID(), returnTo = resultPrefix + bindingId;
    const response = await this.host(async () => { throw new Error("Unexpected callback during SDK initiation."); }).start(returnTo);
    requireCondition([302,303,307].includes(response.status) && response.headers.has("set-cookie"), "SDK transaction cookie/redirect required.");
    await this.bindSdkTransaction(challengeId,bindingId,response.headers.get("location") || "",readSession,endpoint,endpointNonce);
    return {bindingId,response};
  }
  /** Private identity-service port. A remote caller must first pass the pinned Site handoff verifier.
   * Values originate in the real Site SDK authorization response, never browser request parameters. */
  async bindSdkTransaction(challengeId: string, bindingId: string, authorizationUrl: string,
    readSession: ReadAuth0SdkSession, endpoint: SignedArtifact, endpointNonce: string) {
    requireCondition(uuid.test(bindingId), "Invalid SDK binding reference.");
    const {authentication,providerSessionReference} = await this.authentication(readSession), returnTo=resultPrefix+bindingId;
    const redirect = new URL(authorizationUrl), params = redirect.searchParams, p = this.policy.policy;
    for (const key of ["client_id","response_type","redirect_uri","audience","scope","state","nonce","code_challenge","code_challenge_method","max_age"])
      requireCondition(params.getAll(key).length === 1, "Ambiguous or missing SDK authorization parameter.");
    requireCondition(redirect.href.split("?")[0] === `${p.issuer}authorize` && !redirect.hash && !redirect.username && !redirect.password &&
      params.get("client_id") === p.clientId && params.get("audience") === p.audience && params.get("response_type") === "code" && params.get("redirect_uri") === this.callbackUrl.href &&
      params.get("scope")!.split(" ").includes("openid") && !params.get("scope")!.split(" ").includes("offline_access") &&
      /^[A-Za-z0-9_-]{32,128}$/.test(params.get("state")!) && /^[A-Za-z0-9_-]{32,128}$/.test(params.get("nonce")!) &&
      params.get("code_challenge_method") === "S256" && /^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge")!) && params.get("max_age") === "0",
      "SDK authorization context mismatch.");
    const sdk = {stateDigest:sha256(params.get("state")!),sdkNonce:params.get("nonce"),codeChallenge:params.get("code_challenge"),
      codeChallengeMethod:params.get("code_challenge_method"),maxAge:params.get("max_age"),redirectUri:this.callbackUrl.href,
      returnTo,issuer:p.issuer,clientId:p.clientId,providerSessionReference};
    await this.readiness.run(endpoint,endpointNonce,authentication,client => client.query(
      "SELECT economic_bind_confirmation_sdk($1,$2,$3,$4)",[challengeId,bindingId,sdk,authentication]));
  }
  async callback(request: Request, endpoint: SignedArtifact, endpointNonce: string): Promise<Response> {
    const url = new URL(request.url);
    requireCondition(request.method === "GET" && url.origin === this.callbackUrl.origin && url.pathname === this.callbackUrl.pathname &&
      url.searchParams.getAll("state").length === 1, "Exact SDK callback endpoint/state required.");
    const state = url.searchParams.get("state")!;
    // A fresh host per request keeps concurrent callback context isolated. No public "SDK validated" flag exists.
    return this.host(async (error,context,session) => {
      requireCondition(!error && session?.tokenSet.idToken && context.returnTo?.startsWith(resultPrefix), "SDK callback validation failed.");
      const bindingId = context.returnTo!.slice(resultPrefix.length);
      const binding = await this.recordSdkCallback(bindingId,sha256(state),async () => session,endpoint,endpointNonce);
      // Callback success is not consent. Explicit confirmation and the independent issuer admission still follow.
      return new Response(null,{status:303,headers:{location:new URL(binding.return_to,this.callbackUrl.origin).href}});
    }).callback(request);
  }
  /** Authenticated Site onCallback handoff only. Provider JWT and every durable SDK/context guard
   * are rechecked here; this method does not admit consent. */
  async recordSdkCallback(bindingId: string, stateDigest: string, readSession: ReadAuth0SdkSession,
    endpoint: SignedArtifact, endpointNonce: string) {
      const {session,authentication,providerSessionReference} = await this.authentication(readSession);
      const binding = await this.bound(bindingId,authentication,endpoint,endpointNonce);
      requireCondition(stateDigest === binding.state_digest && binding.redirect_uri === this.callbackUrl.href,
        "SDK callback transaction substitution.");
      const challenge = binding.context.challenge.reauthentication;
      const proof = await this.readiness.authentication.verifySdkReauthentication(session!.tokenSet.idToken!,challenge,binding.sdk_nonce,bindingId);
      await this.readiness.run(endpoint,endpointNonce,authentication,async client => {
        const metadata = await this.readiness.authentication.assertReauthentication(proof,challenge,Date.parse(await databaseTime(client))/1000);
        await client.query("SELECT economic_read_confirmation_sdk($1,$2)",[bindingId,authentication]); // Canonical head -> account -> session lock order.
        await bindEconomicSession(client,{issuer:authentication.issuer,providerSubject:authentication.subject,providerSessionReference,
          accountSessionId:challenge.accountSessionId});
        await client.query("SELECT economic_record_confirmation_sdk_callback($1,$2,$3)",[bindingId,{
          stateDigest,sdkNonce:binding.sdk_nonce,returnTo:binding.return_to,subject:proof.subject,issuer:authentication.issuer,
          clientId:authentication.clientId,providerRevision:proof.keyRevision,tokenDigest:metadata.tokenDigest,issuedAt:metadata.issuedAt,
          expiresAt:metadata.expiresAt,authTime:proof.authenticationTime,assurance:proof.acr},authentication]);
        await this.readiness.authentication.assertReauthentication(proof,challenge,Date.parse(await databaseTime(client))/1000);
      });
    return binding;
  }
  /** Called only by a trusted explicit-confirm action, never automatically by onCallback.
   * Reconstruct from durable binding + SDK-held signed ID token; a copied JS proof is not durable authority.
   * The caller delivers this exact body/proof to the existing authenticated issuer bridge.
   */
  async prepareConfirmation(bindingId: string, readSession: ReadAuth0SdkSession, endpoint: SignedArtifact, endpointNonce: string) {
    const {session,authentication} = await this.authentication(readSession);
    requireCondition(session.tokenSet.idToken, "SDK-held reauthentication token required.");
    const binding = await this.bound(bindingId,authentication,endpoint,endpointNonce), challenge = binding.context.challenge.reauthentication;
    requireCondition(binding.callback?.token_digest === sha256(session.tokenSet.idToken), "Durable SDK callback/token association required.");
    const proof = await this.readiness.authentication.verifySdkReauthentication(session.tokenSet.idToken,challenge,binding.sdk_nonce,bindingId);
    const body = JSON.stringify({accountSessionId:challenge.accountSessionId,authenticationDigest:authentication.tokenDigest,
      envelopeDigest:challenge.envelopeDigest,challengeId:binding.challenge_id,transactionId:binding.context.challenge.transaction_id,
      action:challenge.action,reauthenticationDigest:binding.callback.token_digest});
    const proofId = await this.proofs.record(binding.challenge_id,challenge,body,authentication,proof,endpoint,endpointNonce);
    return {body,proofId,authentication,reauthentication:proof};
  }
}
