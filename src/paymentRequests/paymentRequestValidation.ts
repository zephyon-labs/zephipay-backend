import { createHash } from "node:crypto";
import { parseIdempotencyKey as parsePaymentIdempotencyKey, parseUsdcAmount } from "../payments/paymentIntentValidation";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parsePaymentRequestId(value:unknown){if(typeof value!=="string"||!UUID.test(value))throw new PaymentRequestInputError("A valid payment request ID is required.");return value.toLowerCase()}
export function parsePaymentRequestCreate(value:unknown){if(!record(value)||Object.keys(value).some(k=>!["payerAccountId","amount","purpose"].includes(k)))throw invalid();const payerAccountId=parsePaymentRequestId(value.payerAccountId);let amount;try{amount=parseUsdcAmount(value.amount)}catch{throw invalid()}return{payerAccountId,amount,purpose:purpose(value.purpose)}}
export function parsePaymentRequestTransition(value:unknown,accept=false){if(!record(value)||Object.keys(value).some(k=>!["expectedVersion","trustAcknowledgment"].includes(k)))throw invalid();if(typeof value.expectedVersion!=="string"||!/^(0|[1-9]\d*)$/.test(value.expectedVersion))throw invalid();const trust=value.trustAcknowledgment;if(trust!==undefined&&(!accept||!record(trust)||Object.keys(trust).length!==1||trust.acknowledged!==true))throw invalid();return{expectedVersion:BigInt(value.expectedVersion),...(trust?{trustAcknowledgment:{acknowledged:true as const}}:{})}}
export function paymentRequestHash(input:{requesterAccountId:string;payerAccountId:string;amountRaw:bigint;purpose:string|null}){return createHash("sha256").update(JSON.stringify({schemaVersion:1,flow:"request",...input,amountRaw:input.amountRaw.toString(),asset:"USDC"})).digest("hex")}
export function parseIdempotencyKey(value:string|undefined){try{return parsePaymentIdempotencyKey(value)}catch{throw new PaymentRequestInputError("Idempotency-Key must contain 16 to 128 visible ASCII characters.")}}
export class PaymentRequestInputError extends Error {}
function record(v:unknown):v is Record<string,unknown>{return typeof v==="object"&&v!==null&&!Array.isArray(v)}
function purpose(v:unknown):string|null{if(v===undefined||v===null)return null;if(typeof v!=="string")throw invalid();const p=v.trim();if(new TextEncoder().encode(p).length>120)throw new PaymentRequestInputError("Purpose must not exceed 120 UTF-8 bytes.");return p||null}
function invalid(){return new PaymentRequestInputError("A valid payment request is required.")}
