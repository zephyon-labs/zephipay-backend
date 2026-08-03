import { randomUUID, timingSafeEqual } from "node:crypto";

import type { ExternalPrincipal } from "../auth/externalPrincipal";
import { AccountAccessDeniedError, AccountProvisioningService } from "../identity/accountProvisioningService";
import { createPaymentRequestHash } from "../payments/requestHash";
import type { PaymentRecord } from "../payments/paymentTypes";
import { rawUsdcToDisplay, usdcAmountToRaw } from "../payments/paymentIntentValidation";
import type { PaymentPersistence } from "../storage/storageContracts";
import { PaymentVersionConflictError } from "../storage/storageContracts";

export const USDC_DEVNET_MINT = "2w2nqMemQzjwKMk3jEmtXnBqGBXGJLs8FNfb5Khb8E7J";

export type PublicPaymentIntent = Readonly<{
  id: string;
  status: string;
  version: string;
  requestHash: string;
  recipient: string;
  amountRaw: string;
  amount: string;
  asset: "USDC";
  network: "solana-devnet";
  purpose: string;
  createdAt: string;
  userConfirmedAt?: string;
  executionStartedAt?: string;
  submittedAt?: string;
  lastCheckedAt?: string;
  completedAt?: string;
  failedAt?: string;
  solanaSignature?: string;
  confirmedSlot?: string;
  confirmationStatus?: string;
  receiptPda?: string;
  failureCode?: string;
}>;

export class PaymentIntentApplicationError extends Error {
  constructor(
    public readonly kind: "ACCESS_DENIED" | "NOT_FOUND" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "PaymentIntentApplicationError";
  }
}

export type PaymentIntentServiceOptions = Readonly<{
  clock?: () => string;
  createId?: () => string;
  mintAddress?: string;
}>;

export class PaymentIntentService {
  private readonly clock: () => string;
  private readonly createId: () => string;
  private readonly mintAddress: string;

  constructor(
    private readonly accounts: AccountProvisioningService,
    private readonly payments: PaymentPersistence,
    options: PaymentIntentServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
    this.mintAddress = options.mintAddress ?? USDC_DEVNET_MINT;
  }

  async create(principal: ExternalPrincipal, input: Readonly<{
    idempotencyKey: string;
    recipient: string;
    amount: string;
    purpose: string;
  }>): Promise<Readonly<{ paymentIntent: PublicPaymentIntent; created: boolean }>> {
    const actorSubject = await this.resolveActor(principal);
    await this.requireActiveAllowlist(actorSubject);
    const amountRaw = usdcAmountToRaw(input.amount);
    const canonical = {
      actorSubject,
      network: "solana-devnet" as const,
      mintAddress: this.mintAddress,
      recipientAddress: input.recipient,
      amountRaw,
      purpose: input.purpose,
    };
    const claim = await this.payments.claimIdempotencyKey({
      id: this.createId(),
      actorSubject,
      idempotencyKey: input.idempotencyKey,
      requestHash: createPaymentRequestHash(canonical),
      network: canonical.network,
      rail: "solana",
      asset: "USDC",
      mintAddress: canonical.mintAddress,
      recipientAddress: canonical.recipientAddress,
      amountRaw: canonical.amountRaw,
      purpose: canonical.purpose,
    });
    if (claim.outcome === "HASH_CONFLICT") {
      throw new PaymentIntentApplicationError("CONFLICT", "Idempotency key was already used for a different payment intent.");
    }
    return { paymentIntent: toPublicPaymentIntent(claim.payment), created: claim.outcome === "CLAIMED" };
  }

  async find(principal: ExternalPrincipal, paymentId: string): Promise<PublicPaymentIntent> {
    const actorSubject = await this.resolveActor(principal);
    return toPublicPaymentIntent(await this.requireOwnedPayment(paymentId, actorSubject));
  }

  async confirm(principal: ExternalPrincipal, input: Readonly<{
    paymentId: string;
    requestHash: string;
    expectedVersion: bigint;
    requestId?: string;
  }>): Promise<Readonly<{ paymentIntent: PublicPaymentIntent; applied: boolean }>> {
    const actorSubject = await this.resolveActor(principal);
    await this.requireActiveAllowlist(actorSubject);
    const current = await this.requireOwnedPayment(input.paymentId, actorSubject);
    this.requireMatchingHash(current.requestHash, input.requestHash);
    const replay = this.replayResult(current);
    if (replay) return replay;
    if (current.version !== input.expectedVersion) {
      throw new PaymentIntentApplicationError("CONFLICT", "Payment intent version is stale.");
    }
    const occurredAt = this.clock();
    try {
      const updated = await this.payments.transitionPayment({
        paymentId: current.id,
        expectedVersion: input.expectedVersion,
        toStatus: "PROCESSING",
        evidence: { userConfirmedAt: occurredAt, executionStartedAt: occurredAt },
        requestId: input.requestId,
        occurredAt,
      });
      return { paymentIntent: toPublicPaymentIntent(updated), applied: true };
    } catch (error) {
      if (!(error instanceof PaymentVersionConflictError)) throw error;
      const updated = await this.requireOwnedPayment(input.paymentId, actorSubject);
      this.requireMatchingHash(updated.requestHash, input.requestHash);
      const concurrentReplay = this.replayResult(updated);
      if (concurrentReplay) return concurrentReplay;
      throw new PaymentIntentApplicationError("CONFLICT", "Payment intent version is stale.");
    }
  }

  private async resolveActor(principal: ExternalPrincipal): Promise<string> {
    try {
      return (await this.accounts.resolve(principal)).account.actorSubject;
    } catch (error) {
      if (error instanceof AccountAccessDeniedError) {
        throw new PaymentIntentApplicationError("ACCESS_DENIED", "Payment access is unavailable.");
      }
      throw error;
    }
  }

  private async requireActiveAllowlist(actorSubject: string): Promise<void> {
    const entry = await this.payments.findAllowlistEntry(actorSubject);
    const now = Date.parse(this.clock());
    if (!entry || !entry.enabled || entry.revokedAt ||
        (entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= now)) {
      throw new PaymentIntentApplicationError("ACCESS_DENIED", "Beta payment access is unavailable.");
    }
  }

  private async requireOwnedPayment(paymentId: string, actorSubject: string): Promise<PaymentRecord> {
    const payment = await this.payments.findPayment(paymentId);
    if (!payment || payment.actorSubject !== actorSubject) {
      throw new PaymentIntentApplicationError("NOT_FOUND", "Payment intent was not found.");
    }
    return payment;
  }

  private requireMatchingHash(stored: string, submitted: string): void {
    const left = Buffer.from(stored, "hex");
    const right = Buffer.from(submitted, "hex");
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new PaymentIntentApplicationError("CONFLICT", "Payment intent confirmation does not match the created request.");
    }
  }

  private replayResult(payment: PaymentRecord): Readonly<{ paymentIntent: PublicPaymentIntent; applied: false }> | undefined {
    if (["PROCESSING", "UNKNOWN", "COMPLETED"].includes(payment.status)) {
      return { paymentIntent: toPublicPaymentIntent(payment), applied: false };
    }
    if (payment.status === "FAILED") {
      throw new PaymentIntentApplicationError("CONFLICT", "Failed payment intents cannot be confirmed.");
    }
    if (payment.status !== "AWAITING_CONFIRMATION") {
      throw new PaymentIntentApplicationError("CONFLICT", "Payment intent is not confirmable.");
    }
    return undefined;
  }
}

export function toPublicPaymentIntent(payment: PaymentRecord): PublicPaymentIntent {
  return {
    id: payment.id,
    status: payment.status.toLowerCase(),
    version: payment.version.toString(),
    requestHash: payment.requestHash,
    recipient: payment.recipientAddress,
    amountRaw: payment.amountRaw.toString(),
    amount: rawUsdcToDisplay(payment.amountRaw),
    asset: payment.asset,
    network: payment.network,
    purpose: payment.purpose,
    createdAt: payment.createdAt,
    ...(payment.userConfirmedAt ? { userConfirmedAt: payment.userConfirmedAt } : {}),
    ...(payment.executionStartedAt ? { executionStartedAt: payment.executionStartedAt } : {}),
    ...(payment.submittedAt ? { submittedAt: payment.submittedAt } : {}),
    ...(payment.lastCheckedAt ? { lastCheckedAt: payment.lastCheckedAt } : {}),
    ...(payment.completedAt ? { completedAt: payment.completedAt } : {}),
    ...(payment.failedAt ? { failedAt: payment.failedAt } : {}),
    ...(payment.solanaSignature ? { solanaSignature: payment.solanaSignature } : {}),
    ...(payment.confirmedSlot !== undefined ? { confirmedSlot: payment.confirmedSlot.toString() } : {}),
    ...(payment.confirmationStatus ? { confirmationStatus: payment.confirmationStatus } : {}),
    ...(payment.receiptPda ? { receiptPda: payment.receiptPda } : {}),
    ...(payment.failureCode ? { failureCode: payment.failureCode } : {}),
  };
}
