import { createHash, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { validateControlledRuntimeResult, type ControlledRuntimeAction, type ControlledRuntimeResult } from "../runtime/controlledRuntimeResult";

/** Narrow TEST-only Site/BFF protocol. No database-role credential is shared with the Site.
 * The binding pattern matches readiness transport: pinned keys, context, endpoint/action, body,
 * request identity, expiry and a response bound to that exact request. Receiver replay is durable.
 */
export type WebAction = "prepare" | "recover" | "start" | "callback" | "confirm" | "revoke";
export type ControlledAction = WebAction | ControlledRuntimeAction;
export type WebSession = { reference: string; expiresAt: number; subject: string; accessToken: string; idToken: string };
export type HandoffBody = { session: WebSession; paymentId?: string; bindingId?: string; authorizationUrl?: string; stateDigest?: string };
export type HandoffContext = { environment: string; configuration: string; siteOrigin: string; backendOrigin: string; clientId: string; issuer: string };
export type Handoff = { payload: string; signature: string };
export type WebState = { paymentId?: string; state: "READY" | "AUTHENTICATION_REQUIRED" | "CONFIRMABLE" | "CONFIRMED" | "EXPIRED" | "SESSION_CHANGED" | "INELIGIBLE" | "REVOKED"; expiresAt?: string; bindingId?: string };
export const webActions: readonly WebAction[] = ["prepare","recover","start","callback","confirm","revoke"];
export const controlledActions: readonly ControlledAction[] = [...webActions,"runtime-evaluate","runtime-recover"];
export const webUuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export const webDigest = (v: string) => createHash("sha256").update(v).digest("hex");
function check(v: unknown): asserts v { if (!v) throw new Error("Controlled handoff rejected."); }
function seal(value: unknown, key: KeyObject): Handoff {
  check(key.type === "private" && key.asymmetricKeyType === "ed25519");
  const payload=JSON.stringify(value); check(Buffer.byteLength(payload)<=32768);
  return {payload,signature:sign(null,Buffer.from(payload),key).toString("base64url")};
}
function open<T>(packet: Handoff, key: KeyObject): T {
  check(packet && Object.keys(packet).sort().join() === "payload,signature" && typeof packet.payload === "string" && Buffer.byteLength(packet.payload)<=32768 &&
    typeof packet.signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(packet.signature) && key.type === "public" && key.asymmetricKeyType === "ed25519");
  check(verify(null,Buffer.from(packet.payload),key,Buffer.from(packet.signature,"base64url")));
  return JSON.parse(packet.payload);
}
function contextEqual(a: unknown,b: HandoffContext) {
  if(!a || typeof a!=="object")return false;
  const candidate=a as Record<string,unknown>, expected=b as unknown as Record<string,unknown>;
  return Object.keys(candidate).sort().join()===Object.keys(expected).sort().join() && Object.keys(expected).every(key=>candidate[key]===expected[key]);
}
export function signWebRequest(context: HandoffContext, action: ControlledAction, body: HandoffBody, key: KeyObject): Handoff {
  const issuedAt=Math.floor(Date.now()/1000);
  return seal({type:"zephipay-controlled-web-request-v1",context,action,requestId:randomUUID(),issuedAt,expiresAt:issuedAt+60,body},key);
}
export function verifyWebRequest(packet: Handoff, context: HandoffContext, action: ControlledAction, key: KeyObject, now: number) {
  const m=open<{type:string;context:HandoffContext;action:ControlledAction;requestId:string;issuedAt:number;expiresAt:number;body:HandoffBody}>(packet,key);
  check(Object.keys(m).sort().join() === "action,body,context,expiresAt,issuedAt,requestId,type" && m.type === "zephipay-controlled-web-request-v1" &&
    contextEqual(m.context,context) && m.action===action && controlledActions.includes(action) && webUuid(m.requestId) &&
    Number.isSafeInteger(m.issuedAt) && Number.isSafeInteger(m.expiresAt) && m.issuedAt<=now && m.expiresAt>now && m.expiresAt>m.issuedAt && m.expiresAt-m.issuedAt<=60);
  return m as { requestId: string; expiresAt: number; body: HandoffBody };
}
export function signRuntimeResponse(request:Handoff, state:ControlledRuntimeResult, key:KeyObject):Handoff {
  return seal({type:"zephipay-controlled-runtime-response-v1",requestDigest:webDigest(request.payload),state:validateControlledRuntimeResult(state)},key);
}
export function verifyRuntimeResponse(request:Handoff, response:Handoff, key:KeyObject):ControlledRuntimeResult {
  const m=open<{type:string;requestDigest:string;state:ControlledRuntimeResult}>(response,key), original=JSON.parse(request.payload);
  check(Object.keys(m).sort().join()==="requestDigest,state,type" && m.type==="zephipay-controlled-runtime-response-v1" &&
    m.requestDigest===webDigest(request.payload) && original.expiresAt>Date.now()/1000 &&
    ["runtime-evaluate","runtime-recover"].includes(original.action) && m.state.paymentId===original.body.paymentId);
  return validateControlledRuntimeResult(m.state);
}
export function signWebResponse(request: Handoff, state: WebState, key: KeyObject): Handoff {
  return seal({type:"zephipay-controlled-web-response-v1",requestDigest:webDigest(request.payload),state},key);
}
export function verifyWebResponse(request: Handoff, response: Handoff, key: KeyObject): WebState {
  const m=open<{type:string;requestDigest:string;state:WebState}>(response,key), original=JSON.parse(request.payload);
  check(m.type === "zephipay-controlled-web-response-v1" && m.requestDigest===webDigest(request.payload) && original.expiresAt>Date.now()/1000);
  check(m.state && ["READY","AUTHENTICATION_REQUIRED","CONFIRMABLE","CONFIRMED","EXPIRED","SESSION_CHANGED","INELIGIBLE","REVOKED"].includes(m.state.state));
  return m.state;
}
