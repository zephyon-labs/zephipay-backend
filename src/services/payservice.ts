import { createHash } from "node:crypto";

import {
  ComplianceEngine,
  IdentityEngine,
  InMemoryPaymentAdapterRegistry,
  PaymentDecisionPipeline,
  PaymentOrchestrator,
  PaymentRuntime,
  PolicyEngine,
  RiskEngine,
  SolanaPaymentAdapter,
  resolvePaymentRail,
  validatePaymentIntent,
  type ComplianceService,
  type ExecutionContext,
  type IdentityService,
  type PaymentIntent,
  type PolicyService,
  type RiskService,
  type SolanaSettlementResult,
  type SolanaTransferRequest,
  type SolanaTransferResult,
} from "zephyon-protocol";

import {
  executeSolanaSplPay,
  type SolanaSplPayResult,
} from "../adapters/solana/solanaSplPayExecutor";
import { CIRCLE_SOLANA_DEVNET_USDC_MINT } from "../devnet/canonicalDevnetAsset";

export type PaymentResult = SolanaSplPayResult & {
  runtimeId: string;
  paymentId: string;
  transactionId: string;
  purpose: string;
};

const USDC_DEVNET_MINT = CIRCLE_SOLANA_DEVNET_USDC_MINT;

const approvingIdentityService: IdentityService = {
  async verify() {
    return {
      successful: true,
      identity: {
        level: "basic",
        verifiedAt: new Date().toISOString(),
        provider: "zephipay-backend-runtime",
      },
      referenceId: `identity-${crypto.randomUUID()}`,
    };
  },
};

const approvingComplianceService: ComplianceService = {
  async evaluate() {
    return {
      status: "approved",
      reason: "approved_by_policy",
      decidedAt: new Date().toISOString(),
    };
  },
};

const approvingRiskService: RiskService = {
  async evaluate() {
    return {
      status: "approved",
      decidedAt: new Date().toISOString(),
      assessment: {
        score: 5,
        level: "low",
        assessedAt: new Date().toISOString(),
        factors: [],
      },
      reason: "Low-risk backend devnet payment path.",
    };
  },
};

const approvingPolicyService: PolicyService = {
  async evaluate() {
    return {
      status: "approved",
      decidedAt: new Date().toISOString(),
      results: [],
      reason: "Approved by backend devnet policy.",
    };
  },
};

function toRawUsdcAmount(amount: string): number {
  const amountUsd = Number(amount);

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error("Amount must be a positive number.");
  }

  const amountRaw = Math.round(amountUsd * 1_000_000);

  if (!Number.isSafeInteger(amountRaw) || amountRaw <= 0) {
    throw new Error("Amount converts to an invalid raw integer.");
  }

  return amountRaw;
}

function createRuntimeForSolanaDevnetPayment(
  executeTransfer: (
    request: SolanaTransferRequest,
  ) => Promise<SolanaTransferResult>,
  confirmTransfer: (
    request: SolanaTransferRequest & { signature: string },
  ) => Promise<SolanaSettlementResult>,
): PaymentRuntime {
  const registry = new InMemoryPaymentAdapterRegistry();

  registry.register(
    new SolanaPaymentAdapter({
      network: "solana",
      executeTransfer,
      confirmTransfer,
    }),
  );

  const decisionPipeline = new PaymentDecisionPipeline({
    identityEngine: new IdentityEngine(approvingIdentityService),
    complianceEngine: new ComplianceEngine(approvingComplianceService),
    riskEngine: new RiskEngine(approvingRiskService),
    policyEngine: new PolicyEngine(approvingPolicyService),
  });

  const orchestrator = new PaymentOrchestrator({
    clock: () => new Date().toISOString(),
    createTransactionId: () => `txn-${crypto.randomUUID()}`,

    validateIntent: (paymentIntent) => {
      const validation = validatePaymentIntent(paymentIntent);

      if (validation.isValid) {
        return { valid: true };
      }

      return {
        valid: false,
        failure: {
          code: "PAYMENT_INTENT_INVALID",
          reason: validation.errors.join(" "),
          recoverable: false,
        },
      };
    },

    resolveRail: (paymentIntent) =>
      resolvePaymentRail({
        intent: paymentIntent,
        preferredRail: "solana",
        availableRails: registry.listRails(),
      }),

    executePayment: (paymentIntent, transaction) => {
      const adapter = registry.getAdapter(transaction.rail);
      return adapter.execute(paymentIntent, transaction);
    },

    monitorSettlement: (paymentIntent, transaction) => {
      const adapter = registry.getAdapter(transaction.rail);
      return adapter.monitorSettlement(paymentIntent, transaction);
    },

    recordHistory: (result) => {
      console.log("Backend runtime history recorder saw:", {
        status: result.status,
        transactionId: result.transaction.id,
        rail: result.transaction.rail,
      });
    },
  });

  return new PaymentRuntime(decisionPipeline, orchestrator);
}

export async function executePayment(input: {
  recipient: string;
  amount: string;
  purpose: string;
}): Promise<PaymentResult> {
  const { recipient, amount, purpose } = input;
  try {
    let solanaResult: SolanaSplPayResult | undefined;

    const executeTransfer = async (
      request: SolanaTransferRequest,
    ): Promise<SolanaTransferResult> => {
      const reference = createHash("sha256").update(request.intent.id).digest();

      solanaResult = await executeSolanaSplPay({
        recipient: request.intent.recipientWallet,
        amount: request.intent.money.amount.toString(),
        reference,
        memo: request.intent.memo,
      });

      return {
        signature: solanaResult.signature,
        submittedAt: new Date().toISOString(),
      };
    };

    const confirmTransfer = async (
      request: SolanaTransferRequest & { signature: string },
    ): Promise<SolanaSettlementResult> => {
      return {
        signature: request.signature,
        settledAt: new Date().toISOString(),
        confirmationCount: 1,
      };
    };

    const runtime = createRuntimeForSolanaDevnetPayment(
      executeTransfer,
      confirmTransfer,
    );

    const now = new Date().toISOString();
    const amountRaw = toRawUsdcAmount(amount);

    const intent: PaymentIntent = {
      id: `intent-${crypto.randomUUID()}`,
      type: "p2p",
      status: "draft",
      senderId: "zephipay-backend",
      recipientId: recipient,
      money: {
        amount: Number(amount),
        asset: "USDC",
      },
      recipientWallet: recipient,
      mint: USDC_DEVNET_MINT,
      amountRaw,
      memo: purpose,
      createdAt: now,
      updatedAt: now,
    };

    const context: ExecutionContext = {
      requestId: `backend-${crypto.randomUUID()}`,
      requestedAt: now,
      environment: "solana-devnet",
      paymentIntent: intent,
      participant: {
        id: "zephipay-backend",
        participantType: "system",
        displayName: "Zephipay Backend",
        createdAt: now,
      },
      policyContext: {
        intent,
        actorType: "system",
        actorId: "zephipay-backend",
        environment: "solana-devnet",
        requestedAt: now,
      },
      metadata: {
        source: "zephipay-backend",
      },
    };

    const result = await runtime.execute(context);

    if (result.decision.status !== "approved") {
      throw new Error(
        `Payment blocked by runtime decision pipeline: ${result.decision.reason}`,
      );
    }

    if (result.orchestration?.status !== "completed") {
      throw new Error(
        `Payment orchestration did not complete: ${result.orchestration?.status}`,
      );
    }

    if (!solanaResult) {
      throw new Error("Solana executor did not return a payment result.");
    }

    return {
      ...solanaResult,
      runtimeId: context.requestId,
      paymentId: intent.id,
      transactionId: result.orchestration.transaction.id,
      purpose,
    };
  } catch (error) {
    console.error("executePayment failed:", error);
    throw error;
  }
}
