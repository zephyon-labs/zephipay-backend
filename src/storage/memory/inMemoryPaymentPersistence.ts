import type { AllowlistEntry, CreateAllowlistEntryInput } from "../../allowlist/allowlistEntry";
import {
  eventTypeForTransition,
  normalizeTransitionEvidence,
  validatePaymentTransition,
  validateReceiptCompletionTransition,
} from "../../payments/paymentLifecycle";
import { validateRequestHash } from "../../payments/requestHash";
import { createPaymentIdentityRequestHash } from "../../payments/requestHash";
import type {
  CreatePaymentInput,
  InformationalPaymentEventType,
  JsonObject,
  PaymentEvent,
  PaymentEventType,
  PaymentLifecycleEvidence,
  PaymentRecord,
  PaymentIdentitySnapshot,
  PaymentStatus,
} from "../../payments/paymentTypes";
import type { CreatePaymentReceiptInput, PaymentReceipt } from "../../receipts/paymentReceipt";
import {
  cloneJsonObject,
  cloneJsonValue,
  cloneTerminalProof,
  terminalProofToJson,
} from "../jsonValues";
import type {
  AppendInformationalPaymentEventInput,
  IdempotencyClaim,
  PaymentPersistence,
  ClaimPaymentIdentityInput,
  RecentPaymentIdentity,
} from "../storageContracts";
import { PaymentVersionConflictError } from "../storageContracts";

export type InMemoryPaymentPersistenceOptions = Readonly<{
  clock?: () => string;
  resolvePaymentIdentity?: (input: ClaimPaymentIdentityInput) => Promise<Readonly<{
    username: string; displayName: string; accountType: PaymentIdentitySnapshot["accountType"];
    verificationState: PaymentIdentitySnapshot["verificationState"] | "RESTRICTED";
    payabilityState: "AVAILABLE" | "UNAVAILABLE" | "RESTRICTED"; destinationAddress: string;
  }> | undefined>;
}>;

/** Deterministic test adapter. Production code must never select it automatically. */
export class InMemoryPaymentPersistence implements PaymentPersistence {
  private readonly allowlist = new Map<string, AllowlistEntry>();
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly receipts = new Map<string, PaymentReceipt>();
  private readonly events = new Map<string, PaymentEvent[]>();
  private readonly signatures = new Map<string, string>();
  private readonly receiptPdas = new Map<string, string>();
  private readonly runtimeEventIds = new Set<string>();
  private nextEventId = 1n;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly clock: () => string;
  private readonly resolvePaymentIdentity?: InMemoryPaymentPersistenceOptions["resolvePaymentIdentity"];

  constructor(options: InMemoryPaymentPersistenceOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.resolvePaymentIdentity = options.resolvePaymentIdentity;
  }

  createAllowlistEntry(input: CreateAllowlistEntryInput): Promise<AllowlistEntry> {
    return this.exclusive(() => {
      if (this.allowlist.has(input.actorSubject)) {
        throw new Error(`Allowlist entry ${input.actorSubject} already exists.`);
      }
      validateActorSubject(input.actorSubject);
      const addedAt = this.clock();
      if (input.expiresAt &&
          (!Number.isFinite(Date.parse(input.expiresAt)) ||
           Date.parse(input.expiresAt) <= Date.parse(addedAt))) {
        throw new Error("Allowlist expiry must be after its added time.");
      }
      const entry: AllowlistEntry = Object.freeze({
        actorSubject: input.actorSubject,
        enabled: input.enabled ?? true,
        addedAt,
        expiresAt: input.expiresAt,
        note: input.note,
      });
      this.allowlist.set(input.actorSubject, entry);
      return entry;
    });
  }

  async findAllowlistEntry(actorSubject: string): Promise<AllowlistEntry | undefined> {
    const entry = this.allowlist.get(actorSubject);
    return entry ? Object.freeze({ ...entry }) : undefined;
  }

  claimIdempotencyKey(input: CreatePaymentInput): Promise<IdempotencyClaim> {
    return this.exclusive(() => {
      validateRequestHash(input.requestHash);
      validateCreatePayment(input);
      if (input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128) {
        throw new Error("Idempotency key must be between 16 and 128 characters.");
      }
      if (!this.allowlist.has(input.actorSubject)) {
        throw new Error(`Allowlist entry ${input.actorSubject} was not found.`);
      }
      const indexKey = `${input.actorSubject}\u0000${input.idempotencyKey}`;
      const existingId = this.idempotency.get(indexKey);
      if (existingId) {
        const existing = this.requirePayment(existingId);
        return {
          outcome: existing.requestHash === input.requestHash ? "EXISTING" : "HASH_CONFLICT",
          payment: clonePayment(existing),
        };
      }
      if (this.payments.has(input.id)) throw new Error(`Payment ${input.id} already exists.`);
      const now = this.clock();
      const payment: PaymentRecord = Object.freeze({
        ...input,
        recipientType: input.recipientType ?? "DIRECT_WALLET",
        status: "AWAITING_CONFIRMATION",
        version: 0n,
        createdAt: now,
        updatedAt: now,
      });
      this.payments.set(payment.id, payment);
      this.idempotency.set(indexKey, payment.id);
      this.appendEventUnsafe({
        paymentId: payment.id,
        eventType: "CREATED",
        toStatus: "AWAITING_CONFIRMATION",
        occurredAt: now,
      });
      return { outcome: "CLAIMED", payment: clonePayment(payment) };
    });
  }

  claimPaymentIdentityKey(input: ClaimPaymentIdentityInput): Promise<IdempotencyClaim> {
    return this.exclusive(async () => {
      if (!this.resolvePaymentIdentity || input.senderAccountId === input.recipientAccountId) throw new Error("RECIPIENT_UNAVAILABLE");
      const resolved = await this.resolvePaymentIdentity(input);
      if (!resolved || resolved.payabilityState !== "AVAILABLE" || resolved.verificationState === "RESTRICTED") throw new Error("RECIPIENT_UNAVAILABLE");
      const trustOutcome = resolved.verificationState === "VERIFIED" ? "NOT_REQUIRED" as const : "ACKNOWLEDGED" as const;
      if (resolved.verificationState !== "VERIFIED" && !input.trustAcknowledged) throw new Error("TRUST_ACKNOWLEDGMENT_REQUIRED");
      const indexKey = `${input.actorSubject}\u0000${input.idempotencyKey}`;
      const existingId = this.idempotency.get(indexKey);
      const prior = existingId ? this.requirePayment(existingId) : undefined;
      const snapshot: PaymentIdentitySnapshot = Object.freeze({
        accountId: input.recipientAccountId, username: resolved.username, displayName: resolved.displayName,
        accountType: resolved.accountType, verificationState: resolved.verificationState,
        payabilityState: "AVAILABLE", capturedAt: prior?.recipientSnapshot?.capturedAt ?? input.capturedAt, schemaVersion: 1,
        resolutionSource: "RECIPIENT_DIRECTORY", trustOutcome,
      });
      const requestHash = createPaymentIdentityRequestHash({
        actorSubject: input.actorSubject, network: input.network, mintAddress: input.mintAddress,
        recipientAddress: resolved.destinationAddress, amountRaw: input.amountRaw, purpose: input.purpose,
        recipientAccountId: input.recipientAccountId, recipientSnapshot: snapshot,
        trustConfirmationOutcome: trustOutcome,
      });
      if (existingId) {
        const existing = this.requirePayment(existingId);
        return { outcome: existing.requestHash === requestHash ? "EXISTING" : "HASH_CONFLICT", payment: clonePayment(existing) };
      }
      const now = this.clock();
      const payment: PaymentRecord = Object.freeze({
        id: input.id, actorSubject: input.actorSubject, idempotencyKey: input.idempotencyKey, requestHash,
        status: "AWAITING_CONFIRMATION", version: 0n, network: input.network, rail: input.rail,
        asset: input.asset, mintAddress: input.mintAddress, recipientAddress: resolved.destinationAddress,
        amountRaw: input.amountRaw, purpose: input.purpose, recipientType: "PAYMENT_IDENTITY",
        recipientAccountId: input.recipientAccountId, recipientSnapshot: snapshot, recipientSnapshotVersion: 1,
        trustConfirmationOutcome: trustOutcome, createdAt: now, updatedAt: now,
      });
      this.payments.set(payment.id,payment); this.idempotency.set(indexKey,payment.id);
      this.appendEventUnsafe({ paymentId: payment.id, eventType: "CREATED", toStatus: "AWAITING_CONFIRMATION",
        details: { recipientType: "PAYMENT_IDENTITY", recipientAccountId: input.recipientAccountId,
          recipientSnapshotVersion: 1, trustConfirmationOutcome: trustOutcome }, occurredAt: now });
      return { outcome: "CLAIMED", payment: clonePayment(payment) };
    });
  }

  async findPayment(paymentId: string): Promise<PaymentRecord | undefined> {
    const payment = this.payments.get(paymentId);
    return payment ? clonePayment(payment) : undefined;
  }

  async listPaymentsByActor(actorSubject: string, limit: number): Promise<PaymentRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Activity limit is invalid.");
    return [...this.payments.values()].filter((payment) => payment.actorSubject === actorSubject)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, limit).map(clonePayment);
  }

  async listRecentPaymentIdentities(actorSubject: string, limit: number): Promise<RecentPaymentIdentity[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error("Recent limit is invalid.");
    const candidates = [...this.payments.values()].flatMap((payment) => {
      if (payment.actorSubject !== actorSubject || payment.recipientType !== "PAYMENT_IDENTITY" || !payment.recipientSnapshot) return [];
      const confirmed = (this.events.get(payment.id) ?? []).find((event) => event.eventType === "USER_CONFIRMED");
      return confirmed ? [{ payment, confirmedAt: confirmed.occurredAt }] : [];
    }).sort((a,b) => b.confirmedAt.localeCompare(a.confirmedAt) || b.payment.id.localeCompare(a.payment.id));
    const seen = new Set<string>(); const result: RecentPaymentIdentity[] = [];
    for (const candidate of candidates) {
      const accountId = candidate.payment.recipientAccountId!;
      if (seen.has(accountId)) continue;
      seen.add(accountId); result.push(Object.freeze({ ...candidate.payment.recipientSnapshot! }));
      if (result.length === limit) break;
    }
    return result;
  }

  async listPaymentsRequiringReconciliation(limit: number): Promise<PaymentRecord[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Limit must be positive.");
    return [...this.payments.values()]
      .filter(({ status }) => status === "PROCESSING" || status === "UNKNOWN")
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(clonePayment);
  }

  transitionPayment(input: Parameters<PaymentPersistence["transitionPayment"]>[0]): Promise<PaymentRecord> {
    return this.exclusive(() => {
      const current = this.requirePayment(input.paymentId);
      if (current.version !== input.expectedVersion) throw new PaymentVersionConflictError(input.paymentId);
      validatePaymentTransition(current.status, input.toStatus, input.evidence);
      const evidence = normalizeTransitionEvidence(input.toStatus, input.evidence);
      if (evidence.solanaSignature) {
        const signatureOwner = this.signatures.get(evidence.solanaSignature);
        if (signatureOwner && signatureOwner !== input.paymentId) {
          throw new Error("Solana signature already exists.");
        }
      }
      const eventDetails = input.toStatus === "FAILED"
        ? cloneJsonObject({
            ...(input.details ?? {}),
            terminalProof: terminalProofToJson(input.evidence.terminalProof),
          })
        : cloneJsonObject(input.details ?? {});
      const updated = this.applyEvidence(current, input.toStatus, evidence);
      if (evidence.solanaSignature) this.signatures.set(evidence.solanaSignature, input.paymentId);
      this.payments.set(updated.id, updated);
      this.appendEventUnsafe({
        paymentId: updated.id,
        eventType: eventTypeForTransition(current.status, input.toStatus),
        fromStatus: current.status,
        toStatus: updated.status,
        requestId: input.requestId,
        details: eventDetails,
        occurredAt: input.occurredAt,
      });
      return clonePayment(updated);
    });
  }

  recordSignatureObservation(input: Parameters<PaymentPersistence["recordSignatureObservation"]>[0]): Promise<PaymentRecord> {
    return this.exclusive(() => {
      const current = this.requirePayment(input.paymentId);
      if (current.version !== input.expectedVersion) throw new PaymentVersionConflictError(input.paymentId);
      if (current.status !== "PROCESSING" && current.status !== "UNKNOWN") {
        throw new Error("A signature may be observed only for PROCESSING or UNKNOWN payments.");
      }
      const signatureOwner = this.signatures.get(input.solanaSignature);
      if (signatureOwner && signatureOwner !== input.paymentId) throw new Error("Solana signature already exists.");
      if (input.submittedSlot !== undefined && input.submittedSlot < 0n) throw new Error("Submitted slot cannot be negative.");
      if (current.solanaSignature && current.solanaSignature !== input.solanaSignature) {
        throw new Error("An observed Solana signature cannot be replaced.");
      }
      const eventDetails = cloneJsonObject(input.details ?? {});
      const updated = this.applyEvidence(current, current.status, {
        solanaSignature: input.solanaSignature,
        submittedAt: input.submittedAt,
        submittedSlot: input.submittedSlot,
        recentBlockhash: input.recentBlockhash,
      });
      this.signatures.set(input.solanaSignature, input.paymentId);
      this.payments.set(input.paymentId, updated);
      this.appendEventUnsafe({
        paymentId: input.paymentId,
        eventType: "SIGNATURE_OBSERVED",
        runtimeEventId: undefined,
        requestId: input.requestId,
        details: eventDetails,
        occurredAt: input.occurredAt,
      });
      return clonePayment(updated);
    });
  }

  recordSettlementCheck(input: Parameters<PaymentPersistence["recordSettlementCheck"]>[0]): Promise<PaymentRecord> {
    return this.exclusive(() => {
      const current = this.requirePayment(input.paymentId);
      if (current.version !== input.expectedVersion) throw new PaymentVersionConflictError(input.paymentId);
      if (current.status !== "PROCESSING" && current.status !== "UNKNOWN") {
        throw new Error("Settlement checks apply only to PROCESSING or UNKNOWN payments.");
      }
      const updated = this.applyEvidence(current, current.status, { lastCheckedAt: input.lastCheckedAt });
      this.payments.set(input.paymentId, updated);
      return clonePayment(updated);
    });
  }

  recordSettlementConfirmation(input: Parameters<PaymentPersistence["recordSettlementConfirmation"]>[0]): Promise<PaymentRecord> {
    return this.exclusive(() => {
      const current = this.requirePayment(input.paymentId);
      if (current.version !== input.expectedVersion) throw new PaymentVersionConflictError(input.paymentId);
      if (current.status !== "PROCESSING" && current.status !== "UNKNOWN") {
        throw new Error("Settlement confirmation applies only to PROCESSING or UNKNOWN payments.");
      }
      if (input.confirmedSlot < 0n) throw new Error("Confirmed slot cannot be negative.");
      if (current.solanaSignature && current.solanaSignature !== input.solanaSignature) {
        throw new Error("Settlement signature does not match the observed signature.");
      }
      const signatureOwner = this.signatures.get(input.solanaSignature);
      if (signatureOwner && signatureOwner !== input.paymentId) throw new Error("Solana signature already exists.");
      const details = cloneJsonObject({
        ...(input.details ?? {}),
        signature: input.solanaSignature,
        confirmedSlot: input.confirmedSlot.toString(),
      });
      const updated = this.applyEvidence(current, current.status, {
        solanaSignature: input.solanaSignature,
        confirmedSlot: input.confirmedSlot,
        confirmationStatus: "confirmed",
        lastCheckedAt: input.confirmedAt,
      });
      this.signatures.set(input.solanaSignature, input.paymentId);
      this.payments.set(input.paymentId, updated);
      this.appendEventUnsafe({
        paymentId: input.paymentId,
        eventType: "SETTLEMENT_CONFIRMED",
        fromStatus: current.status,
        toStatus: current.status,
        requestId: input.requestId,
        details,
        occurredAt: input.occurredAt,
      });
      return clonePayment(updated);
    });
  }

  appendInformationalEvent(input: AppendInformationalPaymentEventInput): Promise<PaymentEvent> {
    return this.exclusive(() => {
      this.requirePayment(input.paymentId);
      validateInformationalEventType(input.eventType);
      return this.appendEventUnsafe(input);
    });
  }

  async listPaymentEvents(paymentId: string): Promise<PaymentEvent[]> {
    return (this.events.get(paymentId) ?? []).map(cloneEvent);
  }

  async findReceiptByPaymentId(paymentId: string): Promise<PaymentReceipt | undefined> {
    const receipt = this.receipts.get(paymentId);
    return receipt ? cloneReceipt(receipt) : undefined;
  }

  storeVerifiedReceipt(input: Parameters<PaymentPersistence["storeVerifiedReceipt"]>[0]): Promise<Readonly<{ payment: PaymentRecord; receipt: PaymentReceipt }>> {
    return this.exclusive(() => {
      const current = this.requirePayment(input.paymentId);
      if (current.version !== input.expectedVersion) throw new PaymentVersionConflictError(input.paymentId);
      if (this.receipts.has(input.paymentId)) throw new Error(`Payment ${input.paymentId} already has a receipt.`);
      validateReceipt(current, input.receipt);
      const signatureOwner = this.signatures.get(input.receipt.solanaSignature);
      if (signatureOwner && signatureOwner !== input.paymentId) throw new Error("Solana signature already exists.");
      const receiptOwner = this.receiptPdas.get(input.receipt.receiptPda);
      if (receiptOwner && receiptOwner !== input.paymentId) throw new Error("Receipt PDA already exists.");
      if (input.event.runtimeEventId && this.runtimeEventIds.has(input.event.runtimeEventId)) {
        throw new Error("Runtime event ID already exists.");
      }
      const receiptDetails = cloneJsonObject(input.event.details ?? {});
      const evidence: PaymentLifecycleEvidence = {
        solanaSignature: input.receipt.solanaSignature,
        confirmedSlot: input.receipt.slot,
        receiptPda: input.receipt.receiptPda,
        completedAt: input.receipt.verifiedAt,
        confirmationStatus: "confirmed",
      };
      validateReceiptCompletionTransition(current.status, evidence);
      const receipt: PaymentReceipt = Object.freeze({
        ...input.receipt,
        createdAt: input.receipt.createdAt ?? this.clock(),
        rawReceipt: cloneJsonObject(input.receipt.rawReceipt),
      });
      const payment = this.applyEvidence(current, "COMPLETED", evidence);
      this.receipts.set(input.paymentId, receipt);
      this.signatures.set(receipt.solanaSignature, input.paymentId);
      this.receiptPdas.set(receipt.receiptPda, input.paymentId);
      this.payments.set(input.paymentId, payment);
      this.appendEventUnsafe({
        ...input.event,
        paymentId: input.paymentId,
        eventType: "RECEIPT_VERIFIED",
        fromStatus: current.status,
        toStatus: "COMPLETED",
        details: receiptDetails,
      });
      return { payment: clonePayment(payment), receipt: cloneReceipt(receipt) };
    });
  }

  private applyEvidence(current: PaymentRecord, status: PaymentStatus, evidence: PaymentLifecycleEvidence): PaymentRecord {
    const defined = <T>(next: T | undefined, previous: T | undefined): T | undefined => next === undefined ? previous : next;
    return Object.freeze({
      ...current,
      status,
      version: current.version + 1n,
      updatedAt: this.clock(),
      runtimeId: defined(evidence.runtimeId, current.runtimeId),
      runtimePaymentId: defined(evidence.runtimePaymentId, current.runtimePaymentId),
      runtimeTransactionId: defined(evidence.runtimeTransactionId, current.runtimeTransactionId),
      userConfirmedAt: defined(evidence.userConfirmedAt, current.userConfirmedAt),
      executionStartedAt: defined(evidence.executionStartedAt, current.executionStartedAt),
      submittedAt: defined(evidence.submittedAt, current.submittedAt),
      lastCheckedAt: defined(evidence.lastCheckedAt, current.lastCheckedAt),
      completedAt: defined(evidence.completedAt, current.completedAt),
      failedAt: defined(evidence.failedAt, current.failedAt),
      solanaSignature: defined(evidence.solanaSignature, current.solanaSignature),
      recentBlockhash: defined(evidence.recentBlockhash, current.recentBlockhash),
      submittedSlot: defined(evidence.submittedSlot, current.submittedSlot),
      confirmedSlot: defined(evidence.confirmedSlot, current.confirmedSlot),
      confirmationStatus: defined(evidence.confirmationStatus, current.confirmationStatus),
      chainError: evidence.chainError === undefined
        ? current.chainError
        : cloneJsonValue(evidence.chainError),
      receiptPda: defined(evidence.receiptPda, current.receiptPda),
      failureCode: defined(evidence.failureCode, current.failureCode),
      failureReason: defined(evidence.failureReason, current.failureReason),
      terminalProof: evidence.terminalProof
        ? cloneTerminalProof(evidence.terminalProof)
        : current.terminalProof,
    });
  }

  private appendEventUnsafe(input: InternalPaymentEventInput): PaymentEvent {
    if (input.runtimeEventId && this.runtimeEventIds.has(input.runtimeEventId)) {
      throw new Error("Runtime event ID already exists.");
    }
    const events = this.events.get(input.paymentId) ?? [];
    const event: PaymentEvent = Object.freeze({
      id: this.nextEventId++,
      paymentId: input.paymentId,
      sequenceNumber: events.length + 1,
      eventType: input.eventType,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      runtimeEventId: input.runtimeEventId,
      requestId: input.requestId,
      details: cloneJsonObject(input.details ?? {}),
      occurredAt: input.occurredAt ?? this.clock(),
    });
    this.events.set(input.paymentId, [...events, event]);
    if (input.runtimeEventId) this.runtimeEventIds.add(input.runtimeEventId);
    return cloneEvent(event);
  }

  private requirePayment(paymentId: string): PaymentRecord {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error(`Payment ${paymentId} was not found.`);
    return payment;
  }

  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

type InternalPaymentEventInput = Readonly<{
  paymentId: string;
  eventType: PaymentEventType;
  fromStatus?: PaymentStatus;
  toStatus?: PaymentStatus;
  runtimeEventId?: string;
  requestId?: string;
  details?: JsonObject;
  occurredAt?: string;
}>;

const INFORMATIONAL_EVENTS = new Set<InformationalPaymentEventType>([
  "CREATED",
  "USER_CONFIRMED",
  "RUNTIME_APPROVED",
  "SUBMISSION_STARTED",
  "SIGNATURE_OBSERVED",
  "SETTLEMENT_UNKNOWN",
]);

function validateInformationalEventType(eventType: InformationalPaymentEventType): void {
  if (!INFORMATIONAL_EVENTS.has(eventType)) {
    throw new Error(`${eventType} is reserved for authoritative lifecycle persistence.`);
  }
}

function validateActorSubject(actorSubject: string): void {
  if (actorSubject.trim().length < 1 || actorSubject.length > 255) {
    throw new Error("Actor subject must contain between 1 and 255 characters.");
  }
}

function validateCreatePayment(input: CreatePaymentInput): void {
  validateActorSubject(input.actorSubject);
  if (input.amountRaw <= 0n) throw new Error("Payment amountRaw must be positive.");
  if (input.network !== "solana-devnet" || input.rail !== "solana" || input.asset !== "USDC") {
    throw new Error("Only Solana Devnet USDC payments are supported.");
  }
  const purposeBytes = Buffer.byteLength(input.purpose, "utf8");
  if (purposeBytes < 1 || purposeBytes > 120) {
    throw new Error("Purpose must contain between 1 and 120 UTF-8 bytes.");
  }
}

function clonePayment(payment: PaymentRecord): PaymentRecord {
  return Object.freeze({
    ...payment,
    chainError: payment.chainError === undefined
      ? undefined
      : cloneJsonValue(payment.chainError),
    terminalProof: payment.terminalProof
      ? cloneTerminalProof(payment.terminalProof)
      : undefined,
  });
}

function cloneEvent(event: PaymentEvent): PaymentEvent {
  return Object.freeze({ ...event, details: cloneJsonObject(event.details) });
}

function cloneReceipt(receipt: PaymentReceipt): PaymentReceipt {
  return Object.freeze({ ...receipt, rawReceipt: cloneJsonObject(receipt.rawReceipt) });
}

function validateReceipt(payment: PaymentRecord, receipt: CreatePaymentReceiptInput): void {
  if (receipt.paymentId !== payment.id) throw new Error("Receipt payment ID does not match.");
  if (receipt.network !== payment.network || receipt.mintAddress !== payment.mintAddress ||
      receipt.recipientAddress !== payment.recipientAddress || receipt.amountRaw !== payment.amountRaw) {
    throw new Error("Receipt settlement evidence does not match the payment.");
  }
  if (payment.solanaSignature && payment.solanaSignature !== receipt.solanaSignature) {
    throw new Error("Receipt signature does not match the observed payment signature.");
  }
  if (payment.receiptPda && payment.receiptPda !== receipt.receiptPda) {
    throw new Error("Receipt PDA does not match the observed payment receipt PDA.");
  }
  if (!/^[a-f0-9]{64}$/.test(receipt.onchainReference)) {
    throw new Error("Receipt on-chain reference must be a lowercase 32-byte hex value.");
  }
  if (receipt.slot < 0n) throw new Error("Receipt slot cannot be negative.");
  cloneJsonObject(receipt.rawReceipt);
}
