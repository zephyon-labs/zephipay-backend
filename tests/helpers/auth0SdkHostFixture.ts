import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { NextRequest, NextResponse } from "next/server.js";
import type { Auth0SdkHost } from "../../src/economic/confirmation/auth0SdkConfirmationAdapter";
import { accessFixture, profileFixture } from "./realProviderFixtures";
import { providerJwks } from "./providerTokens";

/** The installed public SDK, unmodified. Only its provider network is a deterministic offline fixture.
 * No real Auth0 tenant, wallet, sponsor, signer, Runtime or settlement service is contacted.
 */
export function auth0SdkHostFixture(beforeSave?: (session: import("@auth0/nextjs-auth0/types").SessionData) => import("@auth0/nextjs-auth0/types").SessionData) {
  const p = profileFixture(), origin = "http://localhost:3000", callbackUrl = `${origin}/auth/callback`;
  const jar = new Map<string,string>(), codes = new Map<string,{claims:Record<string,unknown>; used:boolean}>();
  let authorization: URL, successfulHooks = 0, lastIdToken = "", lastAccessToken = "";
  let rejectPkce = false;
  const cookie = () => [...jar].map(([key,value]) => `${key}=${value}`).join("; ");
  const save = (response: Response) => {
    for(const header of response.headers.getSetCookie()) {
      const pair=header.split(";",1)[0], index=pair.indexOf("=");
      if(pair.slice(index+1)) jar.set(pair.slice(0,index),pair.slice(index+1)); else jar.delete(pair.slice(0,index));
    }
  };
  const customFetch: typeof fetch = async (input,init) => {
    const url=String(input);
    if(url===`${p.issuer}.well-known/openid-configuration`) return Response.json({issuer:p.issuer,
      authorization_endpoint:`${p.issuer}authorize`,token_endpoint:`${p.issuer}oauth/token`,jwks_uri:p.keySource,
      response_types_supported:["code"],subject_types_supported:["public"],id_token_signing_alg_values_supported:["RS256"],code_challenge_methods_supported:["S256"]});
    if(url===p.keySource) return Response.json(providerJwks);
    assert.equal(url,`${p.issuer}oauth/token`,"No external network calls permitted");
    const params=new URLSearchParams(String(init?.body)), grant=codes.get(params.get("code") || "");
    if(!grant || grant.used || rejectPkce || createHash("sha256").update(params.get("code_verifier") || "").digest("base64url")!==authorization.searchParams.get("code_challenge"))
      return Response.json({error:"invalid_grant"},{status:400});
    assert.equal(params.get("redirect_uri"),callbackUrl);
    grant.used=true;
    lastAccessToken=await accessFixture({scope:"openid confirm:economic",sub:grant.claims.sub || "subject:alice"});
    lastIdToken=await accessFixture({aud:p.clientId,iat:Math.floor(Date.now()/1000),nonce:authorization.searchParams.get("nonce"),acr:"fixture:mfa",auth_time:Math.floor(Date.now()/1000),...grant.claims});
    return Response.json({token_type:"Bearer",expires_in:240,scope:"openid confirm:economic",access_token:lastAccessToken,id_token:lastIdToken});
  };
  const makeSdk = (onCallback?: Parameters<Auth0SdkHost>[0]) => new Auth0Client({
    domain:new URL(p.issuer).hostname,clientId:p.clientId,clientSecret:"disposable-sdk-client-only",secret:"3".repeat(64),appBaseUrl:origin,
    authorizationParameters:{audience:p.audience,scope:"openid confirm:economic",prompt:"login",max_age:0},
    enableAccessTokenEndpoint:false,enableConnectAccountEndpoint:false,
    session:{rolling:false,cookie:{name:"__zephipay_confirmation_fixture",sameSite:"lax",secure:false}},
    transactionCookie:{prefix:"__zephipay_confirmation_fixture_tx"},
    beforeSessionSaved:async session=>{delete session.tokenSet.refreshToken;return beforeSave ? beforeSave(session) : session;},
    customFetch,
    onCallback:onCallback ? async (error,context,session)=>{
      if(!error) successfulHooks++;
      const result=await onCallback(error,context,session);
      return new NextResponse(result.body,{status:result.status,headers:result.headers});
    } : undefined,
  });
  const host: Auth0SdkHost = onCallback => {
    const sdk=makeSdk(onCallback);
    return {
      async start(returnTo) {
        const url=new URL(`${origin}/auth/login`);url.searchParams.set("returnTo",returnTo);
        const response=await sdk.middleware(new NextRequest(url,{headers:{cookie:cookie()}}));
        authorization=new URL(response.headers.get("location")!);
        // Captured as the server's SDK response, before any browser redirect manipulation.
        return response;
      },
      async callback(request) {
        const response=await sdk.middleware(new NextRequest(request));save(response);return response;
      },
    };
  };
  return {host,callbackUrl,save,cookie,makeSdk,observeAuthorization:(response:Response)=>{authorization=new URL(response.headers.get("location")!);},
    async login() {
      const sdk=makeSdk(), response=await sdk.middleware(new NextRequest(`${origin}/auth/login`));
      authorization=new URL(response.headers.get("location")!);save(response);
      const code=randomUUID();codes.set(code,{claims:{},used:false});
      const url=new URL(callbackUrl);url.searchParams.set("code",code);url.searchParams.set("state",authorization.searchParams.get("state")!);
      const completed=await sdk.middleware(new NextRequest(url,{headers:{cookie:cookie()}}));
      assert.equal(completed.status,307);save(completed);
    },
    authorize:()=>authorization,
    successfulHooks:()=>successfulHooks,
    providerTokens:()=>({idToken:lastIdToken,accessToken:lastAccessToken}),
    rejectPkce:()=>{rejectPkce=true;},
    request(claims:Record<string,unknown>={},changes:{state?:string;cookie?:string}={}) {
      const code=randomUUID();codes.set(code,{claims,used:false});
      const url=new URL(callbackUrl);url.searchParams.set("code",code);url.searchParams.set("state",changes.state || authorization.searchParams.get("state")!);
      return new Request(url,{headers:{cookie:changes.cookie ?? cookie()}});
    },
    readSession:()=>makeSdk().getSession(new NextRequest(`${origin}/confirmation/auth0/result`,{headers:{cookie:cookie()}})),
  };
}
