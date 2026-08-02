import type {
  PaymentEventType,
  PaymentLifecycleEvidence,
  PaymentStatus,
  PaymentTerminalProof,
} from "./paymentTypes";

const LEGAL_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  AWAITING_CONFIRMATION: ["PROCESSING", "FAILED"],
  PROCESSING: ["UNKNOWN", "COMPLETED", "FAILED"],
  UNKNOWN: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

export class InvalidPaymentTransitionError extends Error {
  constructor(from: PaymentStatus, to: PaymentStatus, reason?: string) {
    super(reason ?? `Payment lifecycle transition ${from} -> ${to} is not allowed.`);
    this.name = "InvalidPaymentTransitionError";
  }
}

export function validatePaymentTransition(
  from: PaymentStatus,
  to: PaymentStatus,
  evidence: PaymentLifecycleEvidence = {},
): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new InvalidPaymentTransitionError(from, to);
  }

  if (to === "FAILED") {
    if (!evidence.terminalProof || !evidence.failedAt || !evidence.failureCode) {
      throw new InvalidPaymentTransitionError(
        from,
        to,
        "FAILED requires structured terminal proof, a failure code, and a failure time.",
      );
    }
    validateTerminalProof(from, evidence.terminalProof);
  }

  if (to === "COMPLETED") {
    throw new InvalidPaymentTransitionError(
      from,
      to,
      "COMPLETED is only available through atomic verified receipt persistence.",
    );
  }

  if (
    from === "AWAITING_CONFIRMATION" &&
    to === "PROCESSING" &&
    (!evidence.userConfirmedAt || !evidence.executionStartedAt)
  ) {
    throw new InvalidPaymentTransitionError(
      from,
      to,
      "PROCESSING requires explicit user confirmation and an execution start time.",
    );
  }
}

export function validateReceiptCompletionTransition(
  from: PaymentStatus,
  evidence: PaymentLifecycleEvidence,
): void {
  if (from !== "PROCESSING" && from !== "UNKNOWN") {
    throw new InvalidPaymentTransitionError(from, "COMPLETED");
  }
  if (!evidence.solanaSignature || evidence.confirmedSlot === undefined ||
      !evidence.receiptPda || !evidence.completedAt) {
    throw new InvalidPaymentTransitionError(
      from,
      "COMPLETED",
      "COMPLETED requires a signature, confirmed slot, receipt PDA, and completion time.",
    );
  }
}

export function eventTypeForTransition(
  from: PaymentStatus,
  to: Exclude<PaymentStatus, "COMPLETED">,
): PaymentEventType {
  if (from === "AWAITING_CONFIRMATION" && to === "PROCESSING") {
    return "USER_CONFIRMED";
  }
  if (from === "PROCESSING" && to === "UNKNOWN") {
    return "SETTLEMENT_UNKNOWN";
  }
  if (to === "FAILED" &&
      (from === "AWAITING_CONFIRMATION" || from === "PROCESSING" || from === "UNKNOWN")) {
    return "SETTLEMENT_FAILED";
  }
  throw new InvalidPaymentTransitionError(from, to);
}

export function normalizeTransitionEvidence(
  to: Exclude<PaymentStatus, "COMPLETED">,
  evidence: PaymentLifecycleEvidence = {},
): PaymentLifecycleEvidence {
  if (to !== "FAILED" || !evidence.terminalProof) return evidence;
  const proof = evidence.terminalProof;
  if (proof.kind === "SOLANA_TRANSACTION_ERROR") {
    return {
      ...evidence,
      solanaSignature: proof.signature,
      submittedSlot: proof.slot === undefined ? evidence.submittedSlot : BigInt(proof.slot),
      chainError: proof.chainError,
    };
  }
  if (proof.kind === "EXPIRED_UNSIGNED_TRANSACTION") {
    return { ...evidence, recentBlockhash: proof.recentBlockhash };
  }
  return evidence;
}

function validateTerminalProof(from: PaymentStatus, proof: PaymentTerminalProof): void {
  if (from === "AWAITING_CONFIRMATION" && proof.kind !== "PRE_SUBMISSION_REJECTION") {
    throw new Error("AWAITING_CONFIRMATION may fail only with PRE_SUBMISSION_REJECTION proof.");
  }
  if ((from === "PROCESSING" || from === "UNKNOWN") && proof.kind === "PRE_SUBMISSION_REJECTION") {
    throw new Error(`${from} cannot use PRE_SUBMISSION_REJECTION proof.`);
  }
  if (proof.kind === "PRE_SUBMISSION_REJECTION" &&
      (!proof.code.trim() || !proof.reason.trim())) {
    throw new Error("PRE_SUBMISSION_REJECTION proof is invalid.");
  }
  if (proof.kind === "SOLANA_TRANSACTION_ERROR") {
    if (!proof.signature || (proof.slot !== undefined && !isPostgresBigint(proof.slot))) {
      throw new Error("SOLANA_TRANSACTION_ERROR proof is invalid.");
    }
  }
  if (proof.kind === "EXPIRED_UNSIGNED_TRANSACTION") {
    if (!proof.recentBlockhash || !isPostgresBigint(proof.lastValidBlockHeight) ||
        proof.transactionWasSigned !== false || proof.submissionWasAttempted !== false) {
      throw new Error("EXPIRED_UNSIGNED_TRANSACTION proof is invalid.");
    }
  }
}

function isPostgresBigint(value: string): boolean {
  return /^\d+$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return status === "COMPLETED" || status === "FAILED";
}
