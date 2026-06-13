import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

config();

const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string;
const resourceUrl = "http://localhost:3001/api/agent/costly-data";

async function main() {
  if (!svmPrivateKey) {
    throw new Error("SVM_PRIVATE_KEY missing from .env");
  }

  const signer = await createKeyPairSignerFromBytes(
    base58.decode(svmPrivateKey)
  );

  const client = new x402Client();

  registerExactSvmScheme(client, {
    signer,
  });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  const response = await fetchWithPayment(resourceUrl, {
    method: "GET",
  });

  console.log("Status:", response.status);

  console.log("Headers:");
  response.headers.forEach((value, key) => {
    console.log(`${key}: ${value}`);
  });

  const body = await response.json();

  console.log("Response:");
  console.log(JSON.stringify(body, null, 2));

  if (!response.ok) {
    console.log(`No payment settled. Response status: ${response.status}`);
    return;
  }

  const paymentResponse = new x402HTTPClient(client).getPaymentSettleResponse(
    name => response.headers.get(name)
  );

  console.log("Payment Settlement:");
  console.log(JSON.stringify(paymentResponse, null, 2));

  const boundReceipt = {
    ...body.zephyonReceipt,
    settlementProof: paymentResponse,
  };

  console.log("Bound Zephyon x402 Receipt:");
  console.log(JSON.stringify(boundReceipt, null, 2));
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});