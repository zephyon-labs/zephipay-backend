import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { facilitator } from "@payai/facilitator";
import type { RequestHandler } from "express";

export function createX402Middleware(svmAddress: string): RequestHandler {
  const normalizedAddress = svmAddress.trim();

  if (!normalizedAddress) {
    throw new Error("SVM_ADDRESS is required to construct x402 middleware.");
  }

  const facilitatorClient = new HTTPFacilitatorClient(facilitator);

  return paymentMiddleware(
    {
      "GET /api/agent/costly-data": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            payTo: normalizedAddress,
          },
        ],
        description: "Zephyon agentic payment test resource",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      new ExactSvmScheme(),
    ),
  );
}
