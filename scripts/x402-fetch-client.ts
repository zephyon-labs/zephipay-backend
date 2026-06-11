import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

config();

const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string;

async function main() {
  const signer = await createKeyPairSignerFromBytes(
    base58.decode(svmPrivateKey)
  );

  const client = new x402Client();

  registerExactSvmScheme(client, {
    signer,
  });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  const response = await fetchWithPayment(
    "http://localhost:3001/api/agent/costly-data",
    {
      method: "GET",
    }
  );

  console.log("Status:", response.status);
  console.log("Headers:");
response.headers.forEach((value, key) => {
  console.log(`${key}: ${value}`);
});

  const body = await response.json();

  console.log("Response:");
  console.log(JSON.stringify(body, null, 2));

  if (response.ok) {
    const paymentResponse = new x402HTTPClient(client)
      .getPaymentSettleResponse(name =>
        response.headers.get(name)
      );

    console.log("Payment Settlement:");
    console.log(JSON.stringify(paymentResponse, null, 2));
  }
}

main().catch(console.error);