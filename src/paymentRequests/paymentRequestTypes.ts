export const PAYMENT_REQUEST_STATUSES = ["PENDING","ACCEPTED","DECLINED","CANCELLED","EXPIRED","PAID"] as const;
export type PaymentRequestStatus = typeof PAYMENT_REQUEST_STATUSES[number];
export type PaymentRequestPartySnapshot=Readonly<{accountId:string;username:string;displayName:string;accountType:"PERSONAL"|"CREATOR"|"BUSINESS"|"AI_AGENT";verificationState:"UNVERIFIED"|"PENDING"|"VERIFIED";capturedAt:string;schemaVersion:1}>;

export type PaymentRequestRecord = Readonly<{
  requestId:string; requesterAccountId:string; requesterActorSubject:string; payerAccountId:string;
  requesterSnapshot:PaymentRequestPartySnapshot; payerSnapshot:PaymentRequestPartySnapshot;
  amountRaw:bigint; asset:"USDC"; purpose:string|null; status:PaymentRequestStatus; version:bigint;
  requestHash:string; idempotencyKey:string; createdAt:string; updatedAt:string;
  acceptedAt?:string; declinedAt?:string; cancelledAt?:string; expiredAt?:string; paidAt?:string;
  linkedPaymentIntentId?:string; linkedExecutionId?:string; linkedReceiptId?:string;
}>;

export type CreatePaymentRequestRecord = Omit<PaymentRequestRecord,"status"|"version"|"createdAt"|"updatedAt"> & Readonly<{occurredAt:string}>;
export type PaymentRequestClaim = Readonly<{outcome:"CLAIMED"|"EXISTING"|"HASH_CONFLICT";request:PaymentRequestRecord}>;

export interface PaymentRequestRepository {
  claim(input:CreatePaymentRequestRecord):Promise<PaymentRequestClaim>;
  find(requestId:string):Promise<PaymentRequestRecord|undefined>;
  listVisible(accountId:string,limit:number):Promise<PaymentRequestRecord[]>;
  transition(input:Readonly<{requestId:string;expectedVersion:bigint;actorAccountId:string;toStatus:"ACCEPTED"|"DECLINED"|"CANCELLED";occurredAt:string;linkedPaymentIntentId?:string}>):Promise<PaymentRequestRecord>;
  markPaidByPaymentIntent(input:Readonly<{paymentIntentId:string;executionId:string;receiptId:string;paidAt:string}>):Promise<PaymentRequestRecord|undefined>;
}

export class PaymentRequestVersionConflictError extends Error {}
