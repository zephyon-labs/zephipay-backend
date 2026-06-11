import dotenv from "dotenv";

import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { facilitator } from "@payai/facilitator";

dotenv.config();
const svmAddress = process.env.SVM_ADDRESS;

if (!svmAddress) {
  throw new Error("SVM_ADDRESS missing. Add your Solana receiving wallet address to .env");
}

const facilitatorClient = new HTTPFacilitatorClient(facilitator);

export const x402Middleware = paymentMiddleware(
  {
    "GET /api/agent/costly-data": {
      accepts: [
        {
          scheme: "exact",
          price: "$0.001",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          payTo: svmAddress,
        },
      ],
      description: "Zephyon agentic payment test resource",
      mimeType: "application/json",
    },
  },
  new x402ResourceServer(facilitatorClient).register(
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    new ExactSvmScheme()
  )
);