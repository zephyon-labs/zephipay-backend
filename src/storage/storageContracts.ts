import type { AllowlistEntry, CreateAllowlistEntryInput } from "../allowlist/allowlistEntry";
import type {
  CreatePaymentInput,
  PaymentEvent,
  InformationalPaymentEventType,
  JsonObject,
  PaymentFailureEvidence,
  PaymentLifecycleEvidence,
  PaymentRecord,
  PaymentStatus,
} from "../payments/paymentTypes";
import type { CreatePaymentReceiptInput, PaymentReceipt } from "../receipts/paymentReceipt";

export type IdempotencyClaim =
  | Readonly<{ outcome: "CLAIMED"; payment: PaymentRecord }>
  | Readonly<{ outcome: "EXISTING"; payment: PaymentRecord }>
  | Readonly<{ outcome: "HASH_CONFLICT"; payment: PaymentRecord }>;

export type AppendInformationalPaymentEventInput = Readonly<{
  paymentId: string;
  eventType: InformationalPaymentEventType;
  runtimeEventId?: string;
  requestId?: string;
  details?: JsonObject;
  occurredAt?: string;
}>;

type PaymentTransitionBase = Readonly<{
  paymentId: string;
  expectedVersion: bigint;
  requestId?: string;
  details?: JsonObject;
  occurredAt?: string;
}>;

export type PaymentTransitionInput = PaymentTransitionBase & (
  | Readonly<{
      toStatus: "PROCESSING";
      evidence: PaymentLifecycleEvidence & Readonly<{
        userConfirmedAt: string;
        executionStartedAt: string;
      }>;
    }>
  | Readonly<{
      toStatus: "UNKNOWN";
      evidence?: PaymentLifecycleEvidence;
    }>
  | Readonly<{
      toStatus: "FAILED";
      evidence: PaymentFailureEvidence;
    }>
);

export interface AllowlistRepository {
  createAllowlistEntry(input: CreateAllowlistEntryInput): Promise<AllowlistEntry>;
  findAllowlistEntry(actorSubject: string): Promise<AllowlistEntry | undefined>;
}

export interface PaymentRepository {
  claimIdempotencyKey(input: CreatePaymentInput): Promise<IdempotencyClaim>;
  findPayment(paymentId: string): Promise<PaymentRecord | undefined>;
  listPaymentsRequiringReconciliation(limit: number): Promise<PaymentRecord[]>;
}

export interface PaymentLifecycleRepository {
  transitionPayment(input: PaymentTransitionInput): Promise<PaymentRecord>;

  recordSignatureObservation(input: Readonly<{
    paymentId: string;
    expectedVersion: bigint;
    solanaSignature: string;
    submittedAt: string;
    submittedSlot?: bigint;
    recentBlockhash?: string;
    requestId?: string;
    details?: JsonObject;
    occurredAt?: string;
  }>): Promise<PaymentRecord>;

  recordSettlementCheck(input: Readonly<{
    paymentId: string;
    expectedVersion: bigint;
    lastCheckedAt: string;
  }>): Promise<PaymentRecord>;

  recordSettlementConfirmation(input: Readonly<{
    paymentId: string;
    expectedVersion: bigint;
    solanaSignature: string;
    confirmedSlot: bigint;
    confirmedAt: string;
    requestId?: string;
    details?: JsonObject;
    occurredAt?: string;
  }>): Promise<PaymentRecord>;

  appendInformationalEvent(input: AppendInformationalPaymentEventInput): Promise<PaymentEvent>;
  listPaymentEvents(paymentId: string): Promise<PaymentEvent[]>;
}

export interface ReceiptRepository {
  findReceiptByPaymentId(paymentId: string): Promise<PaymentReceipt | undefined>;
  storeVerifiedReceipt(input: Readonly<{
    paymentId: string;
    expectedVersion: bigint;
    receipt: CreatePaymentReceiptInput;
    event: Readonly<{
      runtimeEventId?: string;
      requestId?: string;
      details?: JsonObject;
      occurredAt?: string;
    }>;
  }>): Promise<Readonly<{ payment: PaymentRecord; receipt: PaymentReceipt }>>;
}

export interface PaymentPersistence
  extends AllowlistRepository,
    PaymentRepository,
    PaymentLifecycleRepository,
    ReceiptRepository {}

export class PaymentVersionConflictError extends Error {
  constructor(paymentId: string) {
    super(`Payment ${paymentId} was modified by another operation.`);
    this.name = "PaymentVersionConflictError";
  }
}
