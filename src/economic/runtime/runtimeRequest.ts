import { requireCondition } from "../foundation/database";
import { exactObject } from "../foundation/strictJson";
import { digest } from "../readiness/signedArtifact";

export type RuntimeRequest = Readonly<{paymentId:string; accountSessionId:string; envelopeDigest:string; consentId:string}>;
/** References only. Evidence, policy, time and decision truth have no caller-supplied fields. */
export function runtimeRequest(value: RuntimeRequest): RuntimeRequest {
  exactObject(value,["paymentId","accountSessionId","envelopeDigest","consentId"]);
  requireCondition(Reflect.ownKeys(value).length===4 && Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>"value" in d),
    "Plain Runtime references required.");
  const uuid=(v:unknown)=>typeof v==="string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
  requireCondition(uuid(value.paymentId)&&uuid(value.accountSessionId)&&uuid(value.consentId)&&digest(value.envelopeDigest),"Invalid Runtime reference.");
  return Object.freeze({...value});
}
